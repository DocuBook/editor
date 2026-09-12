/** WYSIWYG block editor powered by BlockNoteJS. Loads markdown, syncs changes back,
 *  and hosts the xl-ai extension (transport lives in utils/aiTransport).
 *
 *  Keep-alive host: the `cached` editor INSTANCE is created once per file
 *  (utils/editorFactory) and survives tab switches — only the view
 *  (BlockNoteView) remounts. Markdown is parsed once; undo history persists.
 *  In-flight AI is settled and serialized before any view detaches. */
import { useEffect, useRef } from 'react'
import { SuggestionMenuController, getDefaultReactSlashMenuItems, FormattingToolbarController, LinkToolbarController, useExtensionState } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/mantine/style.css'
import '@blocknote/xl-ai/style.css'
import { combineByGroup, SourceBlockWithPreviewExtension, insertOrUpdateBlockForSlashMenu } from '@blocknote/core'
import { Selection, TextSelection } from 'prosemirror-state'
import { getMathSlashMenuItems } from '@blocknote/math-block'
import { getDiagramSlashMenuItems } from '@blocknote/diagram-block'
import { AIExtension } from '@blocknote/xl-ai'
import { useEditorStore } from '../../stores/editor'
import { useTheme } from '../../stores/theme'
import { toast } from 'sonner'
import { findWikilinkAt, openWikilink } from '../../utils/wikilink'
import { isTauri } from '../../lib/ipc'
import { findActiveSuggestionItem, isEnterBeforeInput } from '../../utils/slashMenuFallback'
import { mathDollarToMathML } from '../../utils/mathMarkdown'
import { indentationAt, indentSelection } from '../../utils/mermaidIndent'
import { createQueuedMermaidRender } from '../../utils/mermaidRenderCache'
import { followAiWritingCursorInRoot } from '../../utils/aiFollowScroll'
import { cursorPositionAtMarkdownOffset, markdownOffsetForCursor } from '../../utils/markdownCursor'
import { serializeMarkdown } from '../../utils/markdownSerialization'
import { setPreviewRenderingPaused, setWikilinkStylerPaused } from './setup'
import { FormattingToolbarWithAI, WikiLinkToolbar } from './linkToolbar'
import type { CachedEditor } from '../../utils/editorFactory'
// Mermaid is a singleton; patching it here also covers @blocknote/diagram-block.
import mermaid from 'mermaid'
;(mermaid as any).render = createQueuedMermaidRender(mermaid.render)

export function WysiwygEditor({ cached, markdown, cursorOffset, onCursorOffset, onSync, filePath, isDesktop }: {
  cached: CachedEditor
  markdown: string
  cursorOffset?: number
  onCursorOffset: (offset: number) => void
  onSync: (md: string) => void
  filePath: string
  isDesktop: boolean
}) {
  const { editor } = cached

  useEffect(() => {
    const preserveMermaidIndent = (event: KeyboardEvent) => {
      if (!["Enter", "Tab"].includes(event.key) || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || (event.key === "Enter" && event.shiftKey)) return
      const view = (editor as any).prosemirrorView
      if (!view) return
      const target = event.target
      if (!(target instanceof Node && view.dom.contains(target)) && !view.hasFocus()) return
      const { $from, $to, empty } = view.state.selection
      if (event.key === 'Enter' && $from.node().type.name === 'math') {
        event.preventDefault()
        event.stopImmediatePropagation()
        const selection = Selection.near(view.state.doc.resolve($from.after()), 1)
        view.dispatch(view.state.tr.setSelection(selection))
        return
      }
      if ($from.parent.type.name !== 'diagram' || $to.parent !== $from.parent) return
      const block = editor.getTextCursorPosition().block
      const popupOpenId = editor.getExtension(SourceBlockWithPreviewExtension)?.store.state.popupOpen
      if (popupOpenId !== block.id) return
      const source = $from.parent.textBetween(0, $from.parent.content.size, '\n', '\n')
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Enter') {
        const beforeCaret = source.slice(0, $from.parentOffset)
        view.dispatch(view.state.tr.insertText(`\n${indentationAt(beforeCaret, beforeCaret.length)}`))
      } else if (empty && !event.shiftKey) {
        view.dispatch(view.state.tr.insertText('  '))
      } else {
        const edit = indentSelection(source, $from.parentOffset, $to.parentOffset, event.shiftKey)
        const start = $from.start() + edit.start
        const tr = view.state.tr.insertText(edit.text, start, $from.start() + $to.parentOffset)
        tr.setSelection(TextSelection.create(tr.doc, $from.start() + edit.from, $from.start() + edit.to))
        view.dispatch(tr)
      }
    }
    document.addEventListener('keydown', preserveMermaidIndent, true)
    return () => document.removeEventListener('keydown', preserveMermaidIndent, true)
  }, [editor])

  /** Mobile-web slash-menu Enter fallback (web <640px, non-Tauri only). Soft
   *  keyboards on iOS/Android can deliver the Enter that should confirm the
   *  highlighted item without the plain `keydown` `key === 'Enter' &&
   *  !isComposing` shape BlockNote's suggestion-menu handler matches
   *  (`useSuggestionMenuKeyboardHandler`): the keyboard IME reports it as a
   *  `beforeinput` paragraph/line-break insertion (or a `keydown` with keyCode
   *  13 but no matching `key`). The menu only listens for `keydown`, so the item
   *  never activates.
   *
   *  We resolve the highlighted item from BlockNote's own ARIA wiring and click
   *  it, which runs the same `onItemClick` the keyboard path would. We only
   *  intervene while the menu is open and never touch the event otherwise, so
   *  normal Enter (new block / line break) is unchanged. Desktop (>=640px) and
   *  Tauri always emit a handled keydown, so they are excluded. */
  useEffect(() => {
    if (isTauri || isDesktop) return
    /** Click the item BlockNote marks active — same `onItemClick` the keyboard
     *  path would run. Returns false when the menu is closed or nothing is
     *  highlighted, so callers can leave the event untouched. */
    const activateSelectedItem = (): boolean => {
      const selected = findActiveSuggestionItem(editor.domElement)
      if (!selected) return false
      selected.click()
      return true
    }
    /** Consume the Enter only once an item actually activated, so the default
     *  insertion (new block) does not also run. No active item → the event is
     *  left untouched and normal Enter behavior applies. */
    const confirmSelectedItem = (event: Event) => {
      if (event.defaultPrevented || !activateSelectedItem()) return
      event.preventDefault()
      event.stopPropagation()
    }
    const onBeforeInput = (event: Event) => {
      if (isEnterBeforeInput(event as InputEvent)) confirmSelectedItem(event)
    }
    /** `keyCode` is deliberate: it is the only signal some soft keyboards give
     *  when `key` arrives as `'Unidentified'` for the physical Enter. */
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.code === 'Enter' || event.keyCode === 13) confirmSelectedItem(event)
    }
    document.addEventListener('beforeinput', onBeforeInput, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('beforeinput', onBeforeInput, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [editor, isDesktop])

  /** Hover hint for [[wikilink]]: native title tooltips get cancelled by
   *  ProseMirror's decoration re-rendering, so render a small floating hint
   *  via event delegation (immune to span re-creation). */
  useEffect(() => {
    const el = editor.domElement
    if (!el) return
    const tip = document.createElement('div')
    tip.setAttribute('data-wikilink-tip', '1')
    tip.textContent = 'Cmd+Click to open'
    tip.style.cssText = 'position:fixed;z-index:9999;display:none;pointer-events:none;padding:3px 8px;border-radius:6px;font-size:11px;white-space:nowrap;background:var(--color-surface);color:var(--color-foreground);border:1px solid var(--color-border);box-shadow:0 4px 12px var(--color-shadow);'
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
    setPreviewRenderingPaused(isAiWriting)
    /** Autosave gate (store-level): never persist while xl-ai streams. Dirty is
     *  re-set when writing ends → a fresh autosave writes the full result. */
    useEditorStore.getState().setAiWriting(isAiWriting)
    if (!isAiWriting) (editor as any).prosemirrorView?.dispatch((editor as any).prosemirrorView.state.tr)
    return () => { setWikilinkStylerPaused(false); setPreviewRenderingPaused(false); useEditorStore.getState().setAiWriting(false) }
  }, [isAiWriting, editor])
  const followRef = useRef(true)
  const exitingRef = useRef(false)
  /** Mirrors isAiWriting for the onChange gate (avoids re-subscribing). */
  const aiWritingRef = useRef(false)
  const prevAiWriting = useRef(false)
  /** Settle tab-dirty + undo state once when AI writing ends — the per-flush
   *  onChange is gated during streaming (it fired per token write). */
  useEffect(() => {
    if (prevAiWriting.current && !isAiWriting && !exitingRef.current) {
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

  /** Follow xl-ai's caret, not the whole writing block. A long pre can exceed
   *  the viewport, making block-level bounds permanently out of view and
   *  triggering scroll/layout work on every streamed mutation. */
  useEffect(() => {
    if (!isAiWriting || !aiMenu?.blockId) return
    const root = editor.domElement
    if (!root) return
    let raf = 0
    const scroll = () => {
      if (!followRef.current || raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        followAiWritingCursorInRoot(root, aiMenu.blockId)
      })
    }
    const mo = new MutationObserver(scroll)
    mo.observe(root, { childList: true, subtree: true, characterData: true })
    return () => { mo.disconnect(); if (raf) cancelAnimationFrame(raf) }
  }, [isAiWriting, aiMenu?.blockId, editor])
  const { setBlockEditor, setFlushEditor } = useEditorStore()
  const onSyncRef = useRef(onSync)
  onSyncRef.current = onSync
  const onCursorOffsetRef = useRef(onCursorOffset)
  onCursorOffsetRef.current = onCursorOffset
  const cursorSnapshotRef = useRef<{ blockId: string; textOffset: number } | null>(null)
  const initialCursorOffset = useRef(cursorOffset).current
  const initialMarkdown = useRef(markdown).current
  /** Baseline markdown this instance was loaded from — flushing only writes
   *  when serialized output actually differs (serialization is not idempotent,
   *  it rewrites list formatting). Kept per-mount; the instance itself is
   *  shared across mounts via the cache. */
  const markdownRef = useRef(markdown)
  markdownRef.current = markdown
  const dirtyRef = useRef(false)
  /** TipTap emits `update` for UI-only option changes such as xl-ai toggling
   * editable state when the FAB opens. ProseMirror documents are immutable, so
   * identity changes only when document content actually changes. */
  const documentRef = useRef(editor.prosemirrorState.doc)
  const loadedRef = useRef(cached.loaded)
  const loadedMarkdownRef = useRef(cached.loadedMarkdown)
  const initialLoadRef = useRef(true)

  /** Keep only the local caret. Remote collaboration transactions must not
   * overwrite this snapshot or move another author's selection. */
  useEffect(() => {
    const captureLocalCursor = () => {
      try {
        const selection = editor.prosemirrorState.selection
        if (!selection.empty) return
        cursorSnapshotRef.current = {
          blockId: editor.getTextCursorPosition().block.id,
          textOffset: selection.$head.parent.textBetween(0, selection.$head.parentOffset, '\n', '\n').length,
        }
      } catch {}
    }
    const unsubscribe = editor.onSelectionChange(captureLocalCursor, false)
    captureLocalCursor()
    return unsubscribe
  }, [editor])


  /** Track editor changes — skip initial load (the parse below fires replaceBlocks
   *  before the user has typed anything). */
  useEffect(() => {
    /** After current synchronous ops (replaceBlocks), mark initial load as done */
    queueMicrotask(() => { initialLoadRef.current = false })
    const sub = editor.onChange(() => {
      const document = editor.prosemirrorState.doc
      if (document === documentRef.current) return
      documentRef.current = document
      if (initialLoadRef.current) return
      dirtyRef.current = true
      if (aiWritingRef.current || exitingRef.current) return // exit hook publishes store state after serialization
      useEditorStore.getState().setTabDirty(filePath, true)
      useEditorStore.getState().setUndoRedoState()
    })
    return () => sub()
  }, [editor, filePath])

  useEffect(() => {
    setBlockEditor(editor)
    return () => {
      setBlockEditor(null)
      /** Cancel in-flight AI before the view detaches. The streamed tool
       *  execution touches the ProseMirror view (transact/domAtPos); running
       *  it against an unmounted editor throws "editor view is not available"
       *  and crashes the tree (keep-alive keeps the INSTANCE alive, so the
       *  stream would otherwise complete into a detached view). Abort is a
       *  no-op unless the AI is actually thinking/ai-writing. */
      try {
        ;(editor as any).getExtension?.(AIExtension)?.abort?.('view detached')
      } catch {}
    }
  }, [editor, setBlockEditor])

  /** Register atomic exit: settle AI, serialize, sync cache/store, mark dirty. */
  useEffect(() => {
    const sync = async () => {
      exitingRef.current = true
      try {
      const ai = (editor as any).getExtension?.(AIExtension)
      const isStreaming = () => {
        const state = ai?.store?.state?.aiMenuState
        return state !== 'closed' && (state?.status === 'thinking' || state?.status === 'ai-writing')
      }
      if (isStreaming()) {
        let resolveSettled!: () => void
        const settled = new Promise<void>(resolve => { resolveSettled = resolve })
        const checkSettled = () => { if (!isStreaming()) resolveSettled() }
        const unsubscribe = ai.store.subscribe(checkSettled)
        try {
          await ai.abort('editor exit')
          checkSettled()
          await settled
        } finally {
          unsubscribe()
        }
      }

      /** Only flush content when there are real WYSIWYG edits — serialization is
       *  not idempotent. Cursor capture still runs on every mode/tab switch. */
      let md = markdownRef.current
      if (dirtyRef.current) {
        const serialized = serializeMarkdown(editor)
        if (serialized === null) throw new Error(`Could not serialize ${filePath}`)
        md = serialized
        // Update cache + store before dirty. Autosave can only observe a dirty
        // tab after its complete serialized content is available.
        Object.assign(cached, { loadedMarkdown: serialized })
        loadedMarkdownRef.current = serialized
        markdownRef.current = serialized
        onSyncRef.current(serialized)
        useEditorStore.getState().setTabDirty(filePath, true)
        dirtyRef.current = false
      }
      try {
        const cursor = cursorSnapshotRef.current
        if (cursor) {
          onCursorOffsetRef.current(markdownOffsetForCursor(editor, md, cursor.blockId, cursor.textOffset))
        }
      } catch {}
      } finally {
        exitingRef.current = false
      }
    }
    setFlushEditor(sync)
    return () => setFlushEditor(null)
    /** `cached` is the keep-alive instance (stable per file path) — it is the
     *  load baseline the flush syncs into, so it belongs in the deps. */
  }, [cached, editor, filePath, setFlushEditor])

  /** Load markdown into this editor instance when it first mounts OR when the
   *  incoming markdown actually changed (code-mode edits, external changes).
   *  Keep-alive: a plain tab switch passes the SAME markdown (the tab was
   *  flushed on exit), so the instance is not re-parsed — undo history and
   *  cursor survive. */
  useEffect(() => {
    if (loadedRef.current && loadedMarkdownRef.current === markdown) return
    cached.loaded = true
    loadedRef.current = true
    cached.loadedMarkdown = markdown
    loadedMarkdownRef.current = markdown
    /** Re-parse must not mark the tab dirty: gate onChange until the load
     *  transaction settles (same guard as the initial mount). */
    initialLoadRef.current = true
    try {
      /** Math blocks export as $/$$ but blocknote's markdown parser has no
       *  $ handling — pre-convert to <math> HTML so saved math re-renders. */
      const blocks = editor.tryParseMarkdownToBlocks(mathDollarToMathML(markdown))
      editor.transact(tr => { tr.setMeta('addToHistory', false); editor.replaceBlocks(editor.document, blocks) }); useEditorStore.getState().setUndoRedoState() }
    catch (e) { console.error('BlockNote load:', e); toast.error('Failed to load editor') }
    queueMicrotask(() => { initialLoadRef.current = false })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- guarded by loadedMarkdown comparison
  }, [editor, markdown])

  /** Restore the exact local text position after markdown parsing has replaced blocks. */
  useEffect(() => {
    if (initialCursorOffset === undefined) return
    const position = cursorPositionAtMarkdownOffset(editor, initialMarkdown, initialCursorOffset)
    if (!position) return
    const frame = requestAnimationFrame(() => {
      try {
        const view = editor.prosemirrorView
        let cursorPos: number | undefined
        view.state.doc.descendants((node, pos) => {
          if (cursorPos !== undefined || node.type.name !== 'blockContainer' || node.attrs.id !== position.block.id) return true
          node.forEach((child, offset) => {
            if (cursorPos === undefined && child.type.spec.group === 'blockContent') {
              const maxOffset = Math.max(0, child.content.size)
              cursorPos = pos + offset + 2 + Math.min(position.textOffset, maxOffset)
            }
          })
          return false
        })
        if (cursorPos === undefined) {
          editor.setTextCursorPosition(position.block.id, 'start')
        } else {
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, cursorPos)))
        }
        editor.focus()
        editor.domElement?.querySelector<HTMLElement>(`[data-node-type="blockContainer"][data-id="${position.block.id}"]`)?.scrollIntoView({ block: 'center' })
      } catch {}
    })
    return () => cancelAnimationFrame(frame)
  }, [editor, initialCursorOffset, initialMarkdown])

  return <BlockNoteView editor={editor} theme={useTheme(s => s.colorScheme)} slashMenu={false} formattingToolbar={false} linkToolbar={false} sideMenu={isDesktop}>
    {/** AI interaction surfaces here in the floating chat (AiFloatingChat) — the
     *  built-in block-anchored AIMenuController is intentionally not rendered. */}
    <FormattingToolbarController formattingToolbar={FormattingToolbarWithAI} />
    <LinkToolbarController linkToolbar={WikiLinkToolbar} />
    <SuggestionMenuController triggerCharacter="/"
      getItems={async (query) => {
        const defaultItems = getDefaultReactSlashMenuItems(editor)
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
        if (!query) return combineByGroup(defaultItems, mathItems, diagramItems)
        const q = query.toLowerCase()
        return combineByGroup(defaultItems, mathItems, diagramItems).filter(i =>
          i.title?.toLowerCase().includes(q) ||
          (i.aliases || []).some((a: string) => a.includes(q))
        )
      }}
    />
  </BlockNoteView>
}
