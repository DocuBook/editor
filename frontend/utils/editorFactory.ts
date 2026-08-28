/**
 * Per-tab BlockNote editor cache (keep-alive).
 *
 * Design: one editor *instance* per open tab, held across tab switches.
 * `BlockNoteView` remounts the view (DOM attach/detach) but the instance —
 * and with it the ProseMirror document, undo history, and xl-ai stream
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
import { en as aiDict } from '@blocknote/xl-ai/locales'
import { AIExtension } from '@blocknote/xl-ai'
import { fileUrl } from '../lib/ipc'
import { getSchema, wikilinkStyler } from '../components/editor/setup'
import { createAiTransport } from './aiTransport'

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

/** Create a fresh editor instance bound to the vault + file path.
 *  The AI transport closes over THIS instance, so a stream started in this
 *  tab keeps writing to it even after the user switches away and back.
 *  NOTE: only construct INSIDE a live app (mount) — creating a BlockNote
 *  editor headless (jsdom) touches module-level SideMenu state and throws. */
export function createBlockEditor(vaultPath: string, _filePath: string): CachedEditor {
  let editor!: BlockNoteEditor<any, any, any>
  editor = BlockNoteEditor.create({
    schema: getSchema(),
    dictionary: { ...baseDict, ai: aiDict, math: mathLocales.en, diagram: diagramLocales.en },
    resolveFileUrl: async (url: string) => (vaultPath ? await fileUrl(vaultPath, url) : url),
    extensions: [
      AIExtension({
        transport: createAiTransport({ getEditor: () => editor }),
        agentCursor: { name: 'DocuBook AI', color: 'var(--color-ai-cursor)' },
      }),
      wikilinkStyler,
    ],
  })
  return { editor, loaded: false, loadedMarkdown: null }
}
