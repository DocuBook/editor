import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { ListFilterPlus, ArrowUp, Check, RotateCcw, Loader2 } from 'lucide-react'
import type { AiMenuState } from '../../utils/aiExtension'
import { getDefaultAIMenuItems } from '../../utils/aiMenu'
import { useEditorStore } from '../../stores/editor'
import { useVaultStore } from '../../stores/vault'
import { useAiChat } from '../../stores/aiChat'
import { useAiSettings } from '../../stores/aiSettings'
import { useAiThreads } from '../../stores/aiThreads'
import { toast } from 'sonner'
import { hasAISelection, openAIMenuAtAnchor, restoreAISelection } from '../../utils/aiBlocks'


export default function AiFloatingChat() {
  const editor = useEditorStore((s) => s.blockEditor)
  const activeTab = useEditorStore((s) => s.activeTab)
  const vaultPath = useVaultStore((s) => s.vaultPath)
  const { selectionPromptOpen, expanded, input, focusRequest, setExpanded, setInput, setSelectionPromptOpen } = useAiChat()
  const provider = useAiSettings((s) => s.provider)
  const savedProviders = useAiSettings((s) => s.savedProviders)
  const aiConfigured = !!provider && savedProviders.includes(provider)

  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const ai = editor?.getExtension?.('ai') ?? null

  /** Subscribe to local AI store directly — it's a vanilla Store
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

  /** Keep the caret at the end of a toolbar-injected prompt. Without this the
   *  textarea scrolls back to its first line once it grows past max-h, so a
   *  "Translate" prompt appears to start at the top of the box. */
  useEffect(() => {
    if (!focusRequest) return
    const el = inputRef.current
    if (!el) return
    el.setSelectionRange(el.value.length, el.value.length)
    el.scrollTop = el.scrollHeight
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
    if (status !== 'user-input' || selectionPromptOpen) return []
    return getDefaultAIMenuItems(editor, 'user-input').map((item) => ({
      ...item,
      onItemClick: () => {
        setExpanded(false)
        item.onItemClick((prompt) => useAiChat.getState().focusInput(prompt))
      },
    }))
  }, [status, editor, setExpanded, selectionPromptOpen])

  if (!ai) return null

  /** Selection applies when editor has one; otherwise prompt acts on cursor block. */
  const submit = () => {
    const prompt = input.trim()
    if (!prompt || !aiConfigured) return
    setExpanded(false)
    setSelectionPromptOpen(false)
    if (!isOpen) {
      if (!openAIMenuAtAnchor(editor)) return
    }
    const useSelection = hasAISelection(editor)
    if (useSelection && !restoreAISelection(editor)) {
      toast.error('Text selection is no longer available. Select the text again.')
      ai.closeAIMenu()
      return
    }
    ai.invokeAI({ userPrompt: prompt, useSelection })
    setInput('')
  }

  /** Mirror accept/reject into persisted thread history. The
   *  transport records the "ready for review" marker when a tool call arrives,
   *  so a finished review must rewrite that marker or the panel keeps claiming
   *  the change is still pending. Resolved by file+vault, the same identity the
   *  transport used when it created the thread. */
  const settleThreadStatus = (status: string) => {
    const path = activeTab ?? ''
    if (!path) return
    const thread = useAiThreads.getState().threads.find(
      (item) => item.filePath === path && (item.vaultPath ?? '') === (vaultPath ?? ''),
    )
    if (thread) useAiThreads.getState().updateLatestAssistantStatus(thread.id, status)
  }

  /** AIExtension closes the menu, re-enables the editor, and restores focus. */
  const accept = () => {
    setExpanded(false)
    settleThreadStatus('Document accepted by editor.')
    ai.acceptChanges()
  }
  const revert = () => {
    setExpanded(false)
    settleThreadStatus('Document reverted by editor.')
    ai.rejectChanges()
  }

  /** Composer row of the chat bubble. Empty action toggles AI prompts;
   *  entered text turns it into submit. Enter sends, Shift+Enter adds a line. */
  const promptInput = (
    <div className="flex w-full min-w-0 items-end gap-2 p-2">
      <textarea
        ref={inputRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && hasInput && promptEnabled) { e.preventDefault(); submit() } }}
        rows={1}
        disabled={!promptEnabled}
        placeholder={aiConfigured ? 'Send message to AI writing...' : 'Configure API key in Settings (⌘,)'}
        title={aiConfigured ? 'Enter to send · Shift+Enter for new line' : 'Configure an API key in Settings (⌘,)'}
        className="min-h-7 max-h-30 min-w-0 flex-1 resize-none overflow-y-auto border-none bg-transparent px-1.5 py-1.5 text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-60"
      />
      {/* Selection mode: prompts live in the toolbar popover, so the toggle has
          nothing to open. Typed text still turns this into the send button. */}
      {(hasInput || !selectionPromptOpen) && (
        <button
          onClick={hasInput ? submit : () => useAiChat.getState().togglePrompts()}
          onMouseDown={(e) => e.preventDefault()}
          disabled={!aiConfigured || (hasInput ? !canPrompt : !canTogglePrompts)}
          aria-label={hasInput ? 'Send prompt' : expanded ? 'Hide AI prompts' : 'Show AI prompts'}
          aria-expanded={!hasInput && canTogglePrompts ? expanded : undefined}
          title={hasInput ? 'Send prompt (Enter)' : 'AI prompts'}
          className={
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border-none cursor-pointer disabled:cursor-not-allowed disabled:opacity-35 ' +
            (hasInput
              ? 'bg-accent text-on-accent hover:bg-accent-hover'
              : 'bg-transparent text-foreground hover:bg-surface-active')
          }
        >
          {hasInput ? <ArrowUp size={16} /> : <ListFilterPlus size={16} />}
        </button>
      )}
    </div>
  )

  /** Status bar of the same bubble: one column, one border. Every non-idle
   *  state renders here instead of as its own popover, so the panel keeps a
   *  single stable shape while it moves between thinking, writing, review and
   *  error. */
  const statusBar = status === 'thinking' || status === 'ai-writing' ? (
    <div className="ai-chat-status flex items-center gap-2 border-b border-border-subtle px-3 py-2">
      <Loader2 size={13} className="animate-spin text-accent" />
      <span className="text-xs text-foreground-secondary">
        {status === 'thinking' ? 'Thinking…' : 'Writing…'}
      </span>
      <button
        onClick={() => { setExpanded(false); ai.abort?.('stopped by user').catch(() => {}) }}
        className="ml-auto cursor-pointer rounded border border-border-subtle bg-surface-active px-2 py-1 text-[11px] text-foreground-secondary hover:text-foreground"
      >
        Stop
      </button>
    </div>
  ) : status === 'user-reviewing' ? (
    <div className="ai-chat-status flex items-center gap-2 border-b border-border-subtle px-3 py-2">
      <span className="text-xs text-foreground-secondary">Review the changes</span>
      <div className="ml-auto flex items-center gap-2">
        <button onClick={revert} onMouseDown={(e) => e.preventDefault()} className="cursor-pointer rounded border border-border-subtle bg-surface-active px-2.5 py-1 text-[11px] text-foreground-secondary hover:text-foreground">
          Revert
        </button>
        <button onClick={accept} onMouseDown={(e) => e.preventDefault()} className="flex cursor-pointer items-center gap-1 rounded border-none bg-accent px-2.5 py-1 text-[11px] text-on-accent hover:bg-accent-hover">
          <Check size={11} />
          Accept
        </button>
      </div>
    </div>
  ) : status === 'error' ? (
    <div className="ai-chat-status border-b border-border-subtle px-3 py-2">
      <div className="wrap-break-word text-[11px] text-danger">
        {typeof aiMenu !== 'string' && aiMenu.error ? String(aiMenu.error?.message ?? aiMenu.error) : 'Something went wrong'}
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <button onClick={() => { setExpanded(false); ai.rejectChanges() }} className="cursor-pointer rounded border border-border-subtle bg-surface-active px-2.5 py-1 text-[11px] text-foreground-secondary hover:text-foreground">
          Cancel
        </button>
        <button onClick={() => { setExpanded(false); ai.retry()?.catch(() => {}) }} className="flex cursor-pointer items-center gap-1 rounded border-none bg-accent px-2.5 py-1 text-[11px] text-on-accent hover:bg-accent-hover">
          <RotateCcw size={11} />
          Retry
        </button>
      </div>
    </div>
  ) : null

  return (
    <div
      ref={rootRef}
      className="editor-ai-floating pointer-events-auto absolute bottom-5 left-1/2 z-50 flex -translate-x-1/2 flex-col items-end gap-2"
    >
      {aiConfigured && !selectionPromptOpen && status === 'user-input' && expanded && !hasInput && items.length > 0 && (
        <div className="relative z-30 flex flex-col items-end gap-2">
          {items.map((item) => (
            <button
              key={item.key}
              onClick={item.onItemClick}
              onMouseDown={(e) => e.preventDefault()}
              className="ui-popover relative flex min-h-10 min-w-37 items-center gap-3 px-4 py-2.5 text-left text-xs font-medium text-foreground cursor-pointer"
            >
              <span className="flex w-5 shrink-0 items-center justify-center text-accent">{item.icon}</span>
              {item.title}
            </button>
          ))}
        </div>
      )}

      <div className="ai-chat-surface flex w-full flex-col overflow-hidden rounded-xl border border-border transition-colors focus-within:border-accent">
        {statusBar}
        {promptInput}
      </div>
    </div>
  )
}
