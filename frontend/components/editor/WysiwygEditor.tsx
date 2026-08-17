/** WYSIWYG block editor powered by BlockNoteJS. Loads markdown, syncs changes back,
 *  and hosts the xl-ai extension (transport lives in utils/aiTransport). */
import { useEffect, useState, useRef } from 'react'
import { useCreateBlockNote, SuggestionMenuController, getDefaultReactSlashMenuItems, FormattingToolbarController, LinkToolbarController, useExtensionState } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/mantine/style.css'
import '@blocknote/xl-ai/style.css'
import { en as baseDict } from '@blocknote/core/locales'
import { combineByGroup, SourceBlockWithPreviewExtension, insertOrUpdateBlockForSlashMenu } from '@blocknote/core'
import { getMathSlashMenuItems, locales as mathLocales } from '@blocknote/math-block'
import { getDiagramSlashMenuItems, locales as diagramLocales } from '@blocknote/diagram-block'
import { en as aiDict } from '@blocknote/xl-ai/locales'
import { AIExtension, AIMenuController, getAISlashMenuItems } from '@blocknote/xl-ai'
import { useEditorStore } from '../../stores/editor'
import { useTheme } from '../../stores/theme'
import { toast } from 'sonner'
import { fileUrl } from '../../lib/ipc'
import { useVaultStore } from '../../stores/vault'
import { findWikilinkAt, openWikilink } from '../../utils/wikilink'
import { createAiTransport } from '../../utils/aiTransport'
import { mathDollarToMathML } from '../../utils/mathMarkdown'
import { getSchema, wikilinkStyler, setWikilinkStylerPaused } from './setup'
import { FormattingToolbarWithAI, WikiLinkToolbar } from './linkToolbar'
// Mermaid is a singleton — wrapping render here also patches the instance
// @blocknote/diagram-block uses. Serialize renders (mermaid keeps global
// state; parallel renders race on slow engines like WKWebView) and surface
// the real error instead of blocknote's generic "Invalid diagram".
import mermaid from 'mermaid'
const _mermaidRender = mermaid.render.bind(mermaid)
let _mermaidQueue: Promise<unknown> = Promise.resolve()
;(mermaid as any).render = (id: string, text: string) => {
  const run = _mermaidQueue.then(() =>
    _mermaidRender(id, text).catch((e: unknown) => {
      console.error('[mermaid render]', id, e)
      throw e
    }),
  )
  _mermaidQueue = run.catch(() => {})
  return run
}

/** ── Inner content components (no container — shared scroll in Editor) ── */
/** WYSIWYG block editor powered by BlockNoteJS. Loads markdown, syncs changes back. */
export function WysiwygEditor({ markdown, onSync, filePath }: { markdown: string; onSync: (md: string) => void; filePath: string }) {
  const [clean, setClean] = useState('')
  useEffect(() => { setClean(markdown) }, [markdown])
  const editorRef = useRef<any>(null)
  const vaultPath = useVaultStore(s => s.vaultPath)
  const editor = useCreateBlockNote({
    schema: getSchema(),
    dictionary: { ...baseDict, ai: aiDict, math: mathLocales.en, diagram: diagramLocales.en },
    /** Resolve relative file URLs (images etc) to a loadable URL for this
     *  runtime: base64 data: URL via IPC (Tauri), or /api/file (web). */
    resolveFileUrl: async (url: string) => (vaultPath ? await fileUrl(vaultPath, url) : url),
    extensions: [AIExtension({
      transport: createAiTransport({ getEditor: () => editorRef.current }),
      agentCursor: { name: 'DocuBook AI', color: 'var(--color-ai-cursor)' },
    }), wikilinkStyler],
  }, [markdown])
  useEffect(() => { editorRef.current = editor }, [editor])

  /** Hover hint for [[wikilink]]: native title tooltips get cancelled by
   *  ProseMirror's decoration re-rendering, so render a small floating hint
   *  via event delegation (immune to span re-creation). */
  useEffect(() => {
    const el = editor.domElement
    if (!el) return
    const tip = document.createElement('div')
    tip.setAttribute('data-wikilink-tip', '1')
    tip.textContent = 'Cmd+Click to open'
    tip.style.cssText = 'position:fixed;z-index:9999;display:none;pointer-events:none;padding:3px 8px;border-radius:6px;font-size:11px;white-space:nowrap;background:var(--color-surface,#2a2a2c);color:var(--color-foreground,#fafafa);border:1px solid var(--color-border,#3a3a3c);box-shadow:0 4px 12px rgba(0,0,0,0.3);'
    document.body.appendChild(tip)
    const show = (x: number, y: number) => { tip.style.left = `${x + 10}px`; tip.style.top = `${y + 16}px`; tip.style.display = 'block' }
    const hide = () => { tip.style.display = 'none' }
    const onMouseOver = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (t?.tagName === 'SPAN' && t.getAttribute('data-wikilink') === '1') show(e.clientX, e.clientY)
      else hide()
    }
    el.addEventListener('mouseover', onMouseOver)
    el.addEventListener('mouseleave', hide)
    return () => { el.removeEventListener('mouseover', onMouseOver); el.removeEventListener('mouseleave', hide); tip.remove() }
  }, [editor])

  /** Cmd/Ctrl+Click on a `[[wikilink]]` opens the referenced note
   *  (Obsidian-style). Plain click keeps caret positioning for editing. */
  useEffect(() => {
    const el = editor.domElement
    if (!el) return
    const onClick = (e: MouseEvent) => {
      // Cmd/Ctrl+Click navigation is handled by the wikilinkStyler ProseMirror
      // handleClick prop — skip here so the toast doesn't fire alongside it.
      if (e.metaKey || e.ctrlKey) return
      // Resolve the click position directly (caretRangeFromPoint) — Meta+click
      // does not move the ProseMirror selection, so getSelection() is unreliable.
      const range = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null
      const node = range?.startContainer ?? null
      const off = range?.startOffset ?? 0
      if (!node || node.nodeType !== Node.TEXT_NODE) return
      const title = findWikilinkAt(node.textContent || '', off)
      if (title) {
        const open = () => openWikilink(title)
        // Meta/Ctrl+Click navigation is handled by the wikilinkStyler
        // ProseMirror handleClick prop; this listener only serves
        // the plain-click hint.
        toast('Wikilink — Cmd+Click or Open to navigate', {
          action: { label: 'Open', onClick: open },
          duration: 4000,
        })
      }
    }
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  }, [editor])

  /** Follow the AI writing position. xl-ai's built-in auto-scroll self-disables once content
   *  outgrows the viewport (its scroll-event race kills `autoScroll` under streaming), so we
   *  scroll the writing block ourselves and stop only on real user input (wheel/touch/keys). */
  const aiMenu: any = useExtensionState<any>(AIExtension, { editor, selector: (s: any) => s.aiMenuState })
  const isAiWriting = !!aiMenu && aiMenu !== 'closed' && aiMenu.status === 'ai-writing'
  /** Pause the full-doc wikilink decoration scan while AI streams (it runs on
   *  every transaction = one O(document) regex scan per 50ms batch otherwise).
   *  On unpause, nudge an empty transaction so decorations rescan immediately
   *  (they only recompute on state change). */
  useEffect(() => {
    setWikilinkStylerPaused(isAiWriting)
    if (!isAiWriting) (editor as any).prosemirrorView?.dispatch((editor as any).prosemirrorView.state.tr)
    return () => setWikilinkStylerPaused(false)
  }, [isAiWriting, editor])
  const followRef = useRef(true)
  /** Mirrors isAiWriting for the onChange gate (avoids re-subscribing). */
  const aiWritingRef = useRef(false)
  const prevAiWriting = useRef(false)
  /** Settle tab-dirty + undo state once when AI writing ends — the per-flush
   *  onChange is gated during streaming (it fired per token write). */
  useEffect(() => {
    if (prevAiWriting.current && !isAiWriting) {
      useEditorStore.getState().setTabDirty(filePath, true)
      useEditorStore.getState().setUndoRedoState()
    }
    prevAiWriting.current = isAiWriting
    aiWritingRef.current = isAiWriting
  }, [isAiWriting, filePath])

  /** User scrolling (wheel/touch/scroll keys) stops the follower; re-armed on next AI run. */
  useEffect(() => {
    if (!isAiWriting) { followRef.current = true; return }
    const stop = () => { followRef.current = false }
    const opts = { capture: true, passive: true }
    const keys = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])
    const onKey = (e: KeyboardEvent) => { if (keys.has(e.key)) stop() }
    document.addEventListener('wheel', stop, opts)
    document.addEventListener('touchmove', stop, opts)
    document.addEventListener('keydown', onKey, opts)
    return () => {
      document.removeEventListener('wheel', stop, opts)
      document.removeEventListener('touchmove', stop, opts)
      document.removeEventListener('keydown', onKey, opts)
    }
  }, [isAiWriting])

  /** Token-level scroll: any DOM change in the editor while AI writes keeps the
   *  writing block in view. rAF-throttled AND viewport-aware — it only scrolls
   *  when the block actually leaves the visible area (minimal delta). Constant
   *  re-centering per frame was what made AI typing look janky.
   *
   *  The observer watches ONLY the writing block, not the whole document — a
   *  subtree observer on the editor root fires on every mutation anywhere and
   *  the old code re-ran a full-document querySelector per frame (O(doc)). The
   *  block element is cached; if it's not rendered yet (streaming start), the
   *  observer falls back to the root until the block appears. */
  useEffect(() => {
    if (!isAiWriting || !aiMenu?.blockId) return
    const root = editor.domElement
    if (!root) return
    let raf = 0
    let blockEl: HTMLElement | null = root.querySelector(`[data-node-type="blockContainer"][data-id="${aiMenu.blockId}"]`)
    const scroll = () => {
      if (!followRef.current || raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        if (!blockEl) blockEl = root.querySelector(`[data-node-type="blockContainer"][data-id="${aiMenu.blockId}"]`)
        if (!blockEl) return
        const box = blockEl.getBoundingClientRect()
        // Nearest scrollable ancestor — the editor's scroll container.
        let scroller: HTMLElement | null = blockEl.parentElement
        while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement
        if (!scroller) { blockEl.scrollIntoView({ block: 'nearest' }); return }
        const cbox = scroller.getBoundingClientRect()
        const margin = 32
        if (box.bottom > cbox.bottom - margin) {
          scroller.scrollTop += box.bottom - (cbox.bottom - margin)   // scroll down
        } else if (box.top < cbox.top + margin) {
          scroller.scrollTop -= (cbox.top + margin) - box.top         // scroll up
        }
        // block fully in view — do nothing (no jump, no repaint)
      })
    }
    const mo = new MutationObserver(scroll)
    if (blockEl) {
      mo.observe(blockEl, { childList: true, subtree: true, characterData: true })
    } else {
      mo.observe(root, { childList: true, subtree: true, characterData: true })
    }
    return () => { mo.disconnect(); if (raf) cancelAnimationFrame(raf) }
  }, [isAiWriting, aiMenu?.blockId, editor])
  const { setBlockEditor, setFlushEditor } = useEditorStore()
  const onSyncRef = useRef(onSync)
  onSyncRef.current = onSync
  const markdownRef = useRef(markdown)
  markdownRef.current = markdown
  const dirtyRef = useRef(false)
  const initialLoadRef = useRef(true)

  /** Serialize the editor to markdown for persistence: normalize list markers
   *  and trim blank edges. blocksToMarkdownLossy rewrites list formatting, so
   *  this only runs when the doc is actually dirty. Shared by flush + unmount. */
  const serializeMarkdown = (ed: any): string => {
    try {
      return ed.blocksToMarkdownLossy(ed.document)
        .trim()
        .replace(/^\n+/, '')
        .replace(/\n+$/, '')
        .replace(/^(\s*)\* /gm, '$1- ')
    } catch { return '' }
  }

  /** Track editor changes — skip initial load (filePath stable, remount on file change) */
  useEffect(() => {
    /** After current synchronous ops (replaceBlocks), mark initial load as done */
    queueMicrotask(() => { initialLoadRef.current = false })
    const sub = editor.onChange(() => {
      if (initialLoadRef.current) return
      dirtyRef.current = true
      if (aiWritingRef.current) return // gate UI store spam during AI streaming — settled once at writing end
      useEditorStore.getState().setTabDirty(filePath, true)
      useEditorStore.getState().setUndoRedoState()
    })
    return () => sub()
  }, [editor])

  useEffect(() => {
    setBlockEditor(editor)
    return () => setBlockEditor(null)
  }, [editor, setBlockEditor])

  /** Register flush-to-store for Save button */
  useEffect(() => {
    const sync = () => {
      /** Only flush when there are real WYSIWYG edits — serialization is not
       *  idempotent (it rewrites list formatting), so flushing an untouched doc
       *  would disturb the original markdown on every mode switch. */
      if (!dirtyRef.current) return
      const md = serializeMarkdown(editor)
      if (md && md !== markdownRef.current) onSyncRef.current(md)
    }
    setFlushEditor(sync)
    return () => setFlushEditor(null)
  }, [editor, setFlushEditor])

  useEffect(() => {
    if (!clean) return
    try {
      /** Math blocks export as $/$$ but blocknote's markdown parser has no
       *  $ handling — pre-convert to <math> HTML so saved math re-renders. */
      const blocks = editor.tryParseMarkdownToBlocks(mathDollarToMathML(clean))
      editor.transact(tr => { tr.setMeta('addToHistory', false); editor.replaceBlocks(editor.document, blocks) }); useEditorStore.getState().setUndoRedoState() }
    catch (e) { console.error('BlockNote load:', e); toast.error('Failed to load editor') }
  }, [editor, clean])

  useEffect(() => () => {
    if (!dirtyRef.current) return
    /** Flush on unmount. Must NOT run synchronously: serialization →
     *  exportBlocks → toExternalHTML uses flushSync internally, and React
     *  forbids flushSync from inside a lifecycle method (unmount cleanup runs
     *  during commit). Defer to a microtask so the unmount commit finishes
     *  first. */
    queueMicrotask(() => {
      const md = serializeMarkdown(editor)
      if (md && md !== markdownRef.current) onSyncRef.current(md)
    })
  }, [])

  return <BlockNoteView editor={editor} theme={useTheme(s => s.name)} slashMenu={false} formattingToolbar={false} linkToolbar={false}>
    <AIMenuController />
    {/** Bubble menu (formatting toolbar) with xl-ai entry so the AI text prompt opens from a selection. */}
    <FormattingToolbarController formattingToolbar={FormattingToolbarWithAI} />
    <LinkToolbarController linkToolbar={WikiLinkToolbar} />
    <SuggestionMenuController triggerCharacter="/"
      getItems={async (query) => {
        const defaultItems = getDefaultReactSlashMenuItems(editor)
        const aiItems = getAISlashMenuItems(editor)
        const mathItems = getMathSlashMenuItems(editor)
        const diagramItems = getDiagramSlashMenuItems(editor).map(item => ({
          ...item,
          /** The diagram-block package inserts the block but leaves the popup
           *  closed — the user types into the document instead of the source
           *  editor and the diagram never saves. Parity with the math block:
           *  open the source popup right after insert. */
          onItemClick: () => {
            const block = insertOrUpdateBlockForSlashMenu(editor as any, {
              type: 'diagram',
              content: 'graph TD\n    A[Start] --> B[Stop]',
            } as any)
            editor.getExtension(SourceBlockWithPreviewExtension)
              ?.store.setState(state => ({ ...state, popupOpen: block.id }))
            requestAnimationFrame(() => {
              editor.setTextCursorPosition(block.id, 'end')
              editor.focus()
            })
          },
        }))
        if (!query) return combineByGroup(defaultItems, mathItems, diagramItems, aiItems)
        const q = query.toLowerCase()
        return combineByGroup(defaultItems, mathItems, diagramItems, aiItems).filter(i =>
          i.title?.toLowerCase().includes(q) ||
          (i.aliases || []).some((a: string) => a.includes(q))
        )
      }}
    />
  </BlockNoteView>
}
