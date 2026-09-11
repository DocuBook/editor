import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ListFilterPlus, ArrowUp, Check, RotateCcw, Loader2 } from 'lucide-react'
import { AIExtension, getDefaultAIMenuItems } from '@blocknote/xl-ai'
import { useEditorStore } from '../../stores/editor'
import { useAiChat } from '../../stores/aiChat'
import { useAiSettings } from '../../stores/aiSettings'

/** Shape of the extension store slice we mirror from AIExtension.store. */
type AiMenuState = { blockId: string; status: 'user-input' | 'thinking' | 'ai-writing' | 'user-reviewing' | 'error'; error?: any } | 'closed'

export default function AiFloatingChat() {
  const editor = useEditorStore((s) => s.blockEditor)
  const { expanded, focusRequest, setExpanded } = useAiChat()
  const provider = useAiSettings((s) => s.provider)
  const savedProviders = useAiSettings((s) => s.savedProviders)
  const aiConfigured = !!provider && savedProviders.includes(provider)
  const [input, setInput] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const ai = editor?.getExtension?.(AIExtension) ?? null

  /** Subscribe to AIExtension.store directly — it's a vanilla Store
   *  (subscribe/state), so the chat works outside BlockNote's React context.
   *  Snapshot is `aiMenuState`, the single source of truth for the whole
   *  status machine (thinking / ai-writing / user-reviewing / error). */
  const aiMenu: AiMenuState = useSyncExternalStore(
    useCallback((cb) => (ai ? ai.store.subscribe(cb as any) : () => {}), [ai]),
    () => (ai ? ai.store.state.aiMenuState : 'closed'),
    () => (ai ? ai.store.state.aiMenuState : 'closed'),
  )
  const isOpen = aiMenu !== 'closed'
  const status = isOpen ? aiMenu.status : 'closed'
  const hasInput = input.trim().length > 0
  const canPrompt = status === 'closed' || status === 'user-input' || status === 'user-reviewing'
  const canTogglePrompts = status === 'closed' || status === 'user-input'
  const promptEnabled = aiConfigured && canPrompt

  useEffect(() => {
    if (focusRequest) inputRef.current?.focus({ preventScroll: true })
  }, [focusRequest])

  const close = useCallback(() => {
    if (!ai || aiMenu === 'closed') { setExpanded(false); return }
    if (aiMenu.status === 'thinking' || aiMenu.status === 'ai-writing') {
      ai.abort?.('dismissed by user').catch(() => {})
    } else if (aiMenu.status === 'user-reviewing' || aiMenu.status === 'error') {
      ai.rejectChanges()
    } else {
      ai.closeAIMenu()
    }
    setExpanded(false)
  }, [ai, aiMenu, setExpanded])

  useEffect(() => {
    if (!expanded) return
    const dismissOutside = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close()
    }
    window.addEventListener('mousedown', dismissOutside, true)
    return () => window.removeEventListener('mousedown', dismissOutside, true)
  }, [expanded, close])

  useEffect(() => {
    if (!expanded && !isOpen) return
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close()
    }
    // Capture phase: floating-ui's own dismiss handler swallows Escape in the
    // capture/bubble gap when nothing inside the panel has focus (focus on
    // BODY during review), so a bubble listener never runs.
    window.addEventListener('keydown', dismissOnEscape, true)
    return () => window.removeEventListener('keydown', dismissOnEscape, true)
  }, [expanded, isOpen, close])

  /** Grow the prompt textarea with its content (multi-line prompts must stay
   *  readable) and shrink back when cleared. CSS max-h caps the growth; longer
   *  prompts scroll inside the box.
   *
   *  caniuse audit (app minimum target = Safari 15): scrollHeight + style
   *  height + resize-none + overflow-y-auto are all baseline (~2015), so no
   *  gating needed. Deliberately NOT using `field-sizing: content` — Chrome
   *  123+ / Safari 18.4+ only, which would silently break the auto-grow on
   *  Safari 15. */
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = el.scrollHeight + 'px'
  }, [input])

  const items = useMemo(() => {
    if (status !== 'user-input') return []
    return getDefaultAIMenuItems(editor, 'user-input').map((item) => ({
      ...item,
      onItemClick: () => {
        setExpanded(false)
        item.onItemClick(setInput)
      },
    }))
  }, [status, editor, setExpanded])

  if (!ai) return null

  /** Same default submit as xl-ai's AIMenu: selection is applied when the
   *  editor has one, otherwise the prompt acts on the cursor block. */
  const submit = () => {
    const prompt = input.trim()
    if (!prompt || !aiConfigured) return
    setExpanded(false)
    if (!isOpen) {
      const blockId = editor?.getTextCursorPosition?.()?.block?.id
      if (!blockId) return
      ai.openAIMenuAtBlock(blockId)
    }
    ai.invokeAI({ userPrompt: prompt, useSelection: editor!.getSelection() !== undefined })
    setInput('')
  }

  /** AIExtension closes the menu, re-enables the editor, and restores focus. */
  const accept = () => {
    setExpanded(false)
    ai.acceptChanges()
  }
  const revert = () => {
    setExpanded(false)
    ai.rejectChanges()
  }

  /** Composer stays visible in WYSIWYG. Empty action toggles xl-ai prompts;
   *  entered text turns it into submit. Enter sends and Shift+Enter adds a line. */
  const promptInput = (
    <div className="relative isolate z-20 flex w-full min-w-0 items-end gap-2 rounded-lg border border-border bg-surface p-2 shadow-[0_4px_12px_var(--color-shadow)]">
      <textarea
        ref={inputRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && hasInput && promptEnabled) { e.preventDefault(); submit() } }}
        rows={1}
        disabled={!promptEnabled}
        placeholder={aiConfigured ? 'Send message to AI writing...' : 'Configure API key in Settings (⌘,)'}
        title={aiConfigured ? 'Enter to send · Shift+Enter for new line' : 'Configure an API key in Settings (⌘,)'}
        className="min-w-0 flex-1 resize-none overflow-y-auto border-none bg-transparent px-0 py-1.5 text-xs leading-relaxed text-foreground outline-none placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-60 max-h-30"
      />
      <button
        onClick={hasInput ? submit : () => useAiChat.getState().togglePrompts()}
        onMouseDown={(e) => e.preventDefault()}
        disabled={!aiConfigured || (hasInput ? !canPrompt : !canTogglePrompts)}
        aria-label={hasInput ? 'Send prompt' : expanded ? 'Hide AI prompts' : 'Show AI prompts'}
        aria-expanded={!hasInput && canTogglePrompts ? expanded : undefined}
        title={hasInput ? 'Send prompt (Enter)' : 'AI prompts'}
        className={
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border-none cursor-pointer disabled:cursor-not-allowed disabled:opacity-35 ' +
          (hasInput
            ? 'bg-accent text-on-accent shadow-[0_4px_10px_var(--color-shadow)] hover:bg-accent-hover'
            : 'bg-transparent text-foreground hover:bg-surface-active')
        }
      >
        {hasInput ? <ArrowUp size={16} /> : <ListFilterPlus size={16} />}
      </button>
    </div>
  )

  return (
    <div
      ref={rootRef}
      className="editor-ai-floating pointer-events-auto absolute bottom-5 left-1/2 z-50 flex -translate-x-1/2 flex-col items-end gap-2"
    >
      {aiConfigured && status === 'user-input' && expanded && !hasInput && items.length > 0 && (
        <div className="relative z-30 flex flex-col items-end gap-2">
          {items.map((item) => (
            <button
              key={item.key}
              onClick={item.onItemClick}
              onMouseDown={(e) => e.preventDefault()}
              className="relative flex min-h-10 min-w-37 items-center gap-3 rounded-lg border border-border bg-surface px-4 py-2.5 text-left text-xs font-medium text-foreground shadow-[0_4px_12px_var(--color-shadow)] cursor-pointer hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span className="flex w-5 shrink-0 items-center justify-center text-accent">{item.icon}</span>
              {item.title}
            </button>
          ))}
        </div>
      )}

      {(status === 'thinking' || status === 'ai-writing') && (
        <div className="flex w-full items-center justify-between gap-2 rounded-xl border border-border bg-surface px-3 py-3 shadow-[0_4px_12px_var(--color-shadow)]">
          <span className="flex items-center gap-2 text-xs text-foreground-secondary">
            <Loader2 size={13} className="animate-spin text-accent" />
            {status === 'thinking' ? 'Thinking…' : 'Writing…'}
          </span>
          <button onClick={() => { setExpanded(false); ai.abort?.('stopped by user').catch(() => {}) }} className="text-[11px] px-2 py-1 rounded cursor-pointer bg-surface-active border border-border-subtle text-foreground-secondary hover:text-foreground">
            Stop
          </button>
        </div>
      )}

      {status === 'user-reviewing' && (
        <div className="flex w-full items-center justify-end gap-2 rounded-xl border border-border bg-surface px-3 py-3 shadow-[0_4px_12px_var(--color-shadow)]">
          <span className="mr-auto text-xs text-foreground-secondary">Review the changes</span>
          <button onClick={revert} onMouseDown={(e) => e.preventDefault()} className="text-[11px] px-2.5 py-1 rounded cursor-pointer bg-surface-active border border-border-subtle text-foreground-secondary hover:text-foreground">
            Revert
          </button>
          <button onClick={accept} onMouseDown={(e) => e.preventDefault()} className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded cursor-pointer bg-accent text-on-accent border-none hover:bg-accent-hover">
            <Check size={11} />
            Accept
          </button>
        </div>
      )}

      {status === 'error' && (
        <div className="w-full rounded-xl border border-border bg-surface px-3 py-3 shadow-[0_4px_12px_var(--color-shadow)]">
          <div className="mb-2 wrap-break-word text-[11px] text-danger">
            {typeof aiMenu !== 'string' && aiMenu.error ? String(aiMenu.error?.message ?? aiMenu.error) : 'Something went wrong'}
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => { setExpanded(false); ai.rejectChanges() }} className="text-[11px] px-2.5 py-1 rounded cursor-pointer bg-surface-active border border-border-subtle text-foreground-secondary hover:text-foreground">
              Cancel
            </button>
            <button onClick={() => { setExpanded(false); ai.retry()?.catch(() => {}) }} className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded cursor-pointer bg-accent text-on-accent border-none hover:bg-accent-hover">
              <RotateCcw size={11} />
              Retry
            </button>
          </div>
        </div>
      )}

      {promptInput}
    </div>
  )
}
