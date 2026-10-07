/**
 * Per-tab BlockNote editor cache (keep-alive).
 *
 * Design: one editor *instance* per open tab, held across tab switches.
 * `BlockNoteView` remounts the view (DOM attach/detach) but the instance —
 * and with it the ProseMirror document, undo history, and rust-ai stream
 * state — survives. Markdown is parsed ONCE per instance (first open);
 * switching tabs is O(1) cache lookup instead of O(doc) re-parse.
 *
 * Lifecycle contract:
 * - created lazily on first open of a path
 * - cleared when the vault path changes (rel paths are vault-scoped)
 * - the ACTIVE editor is exposed to the store via `setBlockEditor` (undo/redo,
 *   AI menu); inactive instances stay dormant in the cache.
 */
import { BlockNoteEditor } from '@blocknote/core'
import { en as baseDict } from '@blocknote/core/locales'
import { locales as mathLocales } from '@blocknote/math-block'
import { locales as diagramLocales } from '@blocknote/diagram-block'
import { toast } from 'sonner'
import { AIExtension } from './aiExtension'
import { getAIDictionary } from './aiMenu'
import { mathDollarToMathML } from './mathMarkdown'
import { fileUrl, isAbsoluteUrl, isSafeImageUrl } from '../lib/ipc'
import { getSchema, wikilinkStyler } from '../components/editor/setup'
import { syntaxHighlighting } from './codeHighlighting'
import { createAiTransport } from './aiTransport'
import { createSelectionAwareDocumentStateBuilder } from './aiBlocks'
import { getEditorCache, peekEditorCache } from './editorCache'
import type { WysiwygSnapshot } from './wysiwygSnapshot'

export interface CachedEditor {
  editor: BlockNoteEditor<any, any, any>
  /** True once markdown has been parsed into this instance (load-once). */
  loaded: boolean
  /** The exact markdown this instance was last parsed from — the load effect
   *  re-parses only when the incoming markdown differs (code-mode edits,
   *  external changes), never on a plain tab switch (same content). */
  loadedMarkdown: string | null
}

/** Kept as a public export for the cache unit tests and existing callers. */
export { KeepAliveCache } from './keepAliveCache'

/** Parse `markdown` into `cached` and replace its document — the single load
 *  path, shared by creation (below) and every later re-parse (code-mode edits,
 *  external changes; see WysiwygEditor).
 *
 *  A CREATED instance must be seeded through this before it is first rendered:
 *  the BlockNote default document is a single empty paragraph, and an instance
 *  painted in that state shows BlockNote's placeholder ("Enter text or type '/'
 *  for commands") for as long as the parse takes — the flash every first open
 *  of a note used to show, because the parse lived in a mount effect, i.e.
 *  after the first paint. */
export function loadMarkdownIntoEditor(cached: CachedEditor, markdown: string): boolean {
  const { editor } = cached
  /** Baseline written before the parse (as the inline version did): a failed
   *  parse is not retried on the next mount, where the retry would re-parse
   *  over whatever the user had opened meanwhile. */
  cached.loaded = true
  cached.loadedMarkdown = markdown
  try {
    /** Math blocks export as $/$$ but blocknote's markdown parser has no
     *  $ handling — pre-convert to <math> HTML so saved math re-renders. */
    const blocks = editor.tryParseMarkdownToBlocks(mathDollarToMathML(markdown))
    editor.transact((tr: any) => { tr.setMeta('addToHistory', false); editor.replaceBlocks(editor.document, blocks) })
    return true
  } catch (e) {
    console.error('BlockNote load:', e)
    toast.error('Failed to load editor')
    return false
  }
}

/** Restore a document from a WYSIWYG snapshot — the same load contract as
 *  `loadMarkdownIntoEditor` (seed the baseline before the parse, one no-history
 *  transaction), but the blocks come from the snapshot cache instead of Markdown,
 *  so formatting Markdown cannot represent (colour/alignment/indent) survives.
 *
 *  Callers MUST have validated `snapshot.markdown === markdown` first: the
 *  snapshot is only trustworthy while it still describes the file. A failure here
 *  returns `false` so the caller falls back to parsing the Markdown. */
export function loadSnapshotIntoEditor(cached: CachedEditor, markdown: string, blocks: unknown[]): boolean {
  const { editor } = cached
  cached.loaded = true
  cached.loadedMarkdown = markdown
  try {
    editor.transact((tr: any) => { tr.setMeta('addToHistory', false); editor.replaceBlocks(editor.document, blocks as any) })
    return true
  } catch (e) {
    console.error('BlockNote snapshot load:', e)
    return false
  }
}

/** Seed a freshly-created instance: restore from the WYSIWYG snapshot when it
 *  still describes `markdown`, otherwise parse the markdown. Returns whether the
 *  snapshot was used. The snapshot is applied only while it matches AND carries
 *  blocks; anything else (stale, absent, empty, unreadable) falls back to parsing. */
export function seedCachedEditor(cached: CachedEditor, markdown: string, snapshot?: WysiwygSnapshot | null): boolean {
  const restored = !!snapshot && snapshot.markdown === markdown && snapshot.blocks.length > 0
    && loadSnapshotIntoEditor(cached, markdown, snapshot.blocks)
  if (!restored) return loadMarkdownIntoEditor(cached, markdown)
  return true
}

/** Create a fresh editor instance bound to the vault + file path.
 *  The AI transport closes over THIS instance. Active streams are settled by
 *  WysiwygEditor's exit hook before a tab switch detaches its view.
 *  NOTE: only construct INSIDE a live app (mount) — creating a BlockNote
 *  editor headless (jsdom) touches module-level SideMenu state and throws.
 *
 *  `markdown` is the instance's content, parsed here so the instance's FIRST
 *  render is the note itself (see loadMarkdownIntoEditor). Omitted only by
 *  callers with nothing to seed (unit tests).
 *
 *  `snapshot` is the WYSIWYG-only cache for this file: when it still matches
 *  `markdown` it is seeded INSTEAD of parsing, so the first paint already carries
 *  formatting Markdown drops. It is otherwise ignored (see `loadSnapshotIntoEditor`). */
export function createBlockEditor(vaultPath: string, filePath: string, markdown?: string, snapshot?: WysiwygSnapshot | null): CachedEditor {
  let editor!: BlockNoteEditor<any, any, any>
  editor = BlockNoteEditor.create({
    schema: getSchema(),
    dictionary: { ...baseDict, ai: getAIDictionary(), math: mathLocales.en, diagram: diagramLocales.en },

    resolveFileUrl: async (url: string) => {
      if (!isSafeImageUrl(url)) return ''
      return !vaultPath || isAbsoluteUrl(url) ? url : await fileUrl(vaultPath, url)
    },
    extensions: [
      AIExtension({
        transport: createAiTransport({ getEditor: () => editor, filePath }),
        documentStateBuilder: createSelectionAwareDocumentStateBuilder(async (request: any) =>
          (await import('./aiBlocks')).buildHtmlDocumentState(request.editor, !!request.selectedBlocks?.length),
        ),
        agentCursor: { name: 'DocuBook AI', color: 'var(--color-ai-cursor)' },
      }),
      wikilinkStyler,
      syntaxHighlighting,
    ],
  })
  const cached: CachedEditor = { editor, loaded: false, loadedMarkdown: null };
  if (markdown !== undefined) seedCachedEditor(cached, markdown, snapshot)
  return cached;
}

/** The single chokepoint for the shared editor cache.
 *
 *  Every way a document can be opened — sidebar tree, search modal, wikilink,
 *  backlinks, git panel, or a plain tab switch — ends at the active tab and is
 *  rendered by WysiwygEditorHost, which resolves its instance here. One
 *  instance per (vault, path), so returning to a tab is a Map lookup instead of
 *  a markdown re-parse, whatever the entry point was.
 *
 *  `markdown` seeds a MISS (see createBlockEditor). A hit is already loaded,
 *  so it is ignored: re-parsing on every lookup would throw away undo history
 *  and the in-flight edit state the cache exists to keep.
 *
 *  `snapshot` is the file's WYSIWYG-only cache; a miss is seeded from it when it
 *  still matches `markdown`, so the first paint already carries formatting
 *  Markdown drops (see seedCachedEditor).
 *
 *  Seeding happens HERE, not inside the cache's `create`. That factory is fixed
 *  for the whole vault, so closing over `markdown` made whichever file opened
 *  first seed every later file: the new tab painted the PREVIOUS note and then
 *  re-parsed to its own — and that `replaceBlocks` rebuilds the math / code /
 *  mermaid blocks, flashing their raw source until each one re-renders. */
export function getCachedEditor(vaultPath: string, filePath: string, markdown?: string, snapshot?: WysiwygSnapshot | null): CachedEditor {
  const cached = getEditorCache<CachedEditor>(vaultPath, path => createBlockEditor(vaultPath, path)).get(filePath)
  // A hit is already loaded; only a fresh entry is seeded, with its OWN markdown
  // (or its WYSIWYG snapshot when that still matches the markdown).
  if (markdown !== undefined && !cached.loaded) seedCachedEditor(cached, markdown, snapshot)
  return cached
}

/** Same cache, read-only: returns an already-created instance or null. Lets a
 *  component render the cached editor on the FIRST paint instead of showing a
 *  loading placeholder while an effect resolves what is already in memory. */
export function peekCachedEditor(vaultPath: string, filePath: string): CachedEditor | null {
  return peekEditorCache<CachedEditor>(vaultPath, filePath);
}
