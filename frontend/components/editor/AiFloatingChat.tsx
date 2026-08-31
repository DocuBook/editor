import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Sparkles, X, ArrowUp, Check, RotateCcw, Loader2 } from 'lucide-react'
import { AIExtension, getDefaultAIMenuItems } from '@blocknote/xl-ai'
import { useEditorStore } from '../../stores/editor'
import { useAiChat } from '../../stores/aiChat'
import { useAiSettings } from '../../stores/aiSettings'

/** Shape of the extension store slice we mirror from AIExtension.store. */
type AiMenuState = { blockId: string; status: 'user-input' | 'thinking' | 'ai-writing' | 'user-reviewing' | 'error'; error?: any } | 'closed'

export default function AiFloatingChat() {
  const editor = useEditorStore((s) => s.blockEditor)
  const { expanded, setExpanded } = useAiChat()
  const provider = useAiSettings((s) => s.provider)
  const savedProviders = useAiSettings((s) => s.savedProviders)
  const aiConfigured = !!provider && savedProviders.includes(provider)
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

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

  useEffect(() => {
    setExpanded(isOpen)
  }, [isOpen, setExpanded])

  /** Auto-focus the prompt input whenever the chat shows its input state —
   *  parity with the old xl-ai menu. Keyed on visibility, so typing/re-renders
   *  (input stays mounted) never steal focus back from the editor. */
  const inputShown = status === 'user-input' && (expanded || isOpen)
  useEffect(() => {
    if (inputShown) inputRef.current?.focus()
  }, [inputShown])

  /** Selection-aware suggestions (getDefaultAIMenuItems branches on
   *  editor.getSelection()). Clicking a chip either runs the command directly
   *  or pre-fills the input (e.g. "Write anything", "Translate"). */
  const items = useMemo(() => {
    if (status !== 'user-input') return []
    return getDefaultAIMenuItems(editor, 'user-input').map((item) => ({
      ...item,
      onItemClick: () => {
        item.onItemClick(setInput)
        requestAnimationFrame(() => inputRef.current?.focus())
      },
    }))
  }, [status, editor, setInput])

  if (!ai) return null

  /** Close = collapse to the FAB. Mirrors the old popover's dismiss rules:
   *  streaming aborts, pending review/error rejects, idle closes. */
  const close = () => {
    if (!isOpen) { setExpanded(false); return }
    if (status === 'thinking' || status === 'ai-writing') {
      ai.abort?.('dismissed by user').catch(() => {})
    } else if (status === 'user-reviewing' || status === 'error') {
      ai.rejectChanges()
    } else {
      ai.closeAIMenu()
    }
    setExpanded(false)
  }

  /** Same default submit as xl-ai's AIMenu: selection is applied when the
   *  editor has one, otherwise the prompt acts on the cursor block. */
  const submit = () => {
    const prompt = input.trim()
    if (!prompt) return
    ai.invokeAI({ userPrompt: prompt, useSelection: editor!.getSelection() !== undefined })
    setInput('')
  }

  /** Panel is hidden only when both collapsed AND the AI menu is closed. */
  if (!expanded && !isOpen) {
    return (
      <button
        onClick={() => useAiChat.getState().toggle()}
        aria-label="Ask AI"
        title="Ask AI (⌃⌥L)"
        className="fixed bottom-10 right-4 z-40 flex h-10 w-10 items-center justify-center rounded-full bg-accent text-white shadow-lg cursor-pointer border-none hover:bg-accent-hover focus-visible:outline-none"
      >
        <Sparkles size={17} />
      </button>
    )
  }

  return (
    <div className="fixed bottom-10 right-4 z-40 w-[380px] max-w-[calc(100vw-2rem)] bg-surface border border-border rounded-xl shadow-[0_4px_12px_rgba(0,0,0,0.3)] overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle">
        <Sparkles size={14} className="text-accent shrink-0" />
        <span className="text-xs font-semibold text-foreground">DocuBook AI</span>
        <span className={'text-[10px] px-1.5 py-0.5 rounded border ' + (aiConfigured ? 'text-accent bg-surface-active border-border-subtle' : 'text-amber-400 bg-amber-500/15 border-amber-500/30')} title={aiConfigured ? 'AI configured' : 'Configure an API key in Settings (⌘,)'}>
          {aiConfigured ? 'AI ready' : 'Not configured'}
        </span>
        <button onClick={close} aria-label="Close AI chat" className="ml-auto p-1 rounded cursor-pointer bg-transparent text-muted border-none hover:text-foreground-secondary">
          <X size={14} />
        </button>
      </div>

      {status === 'user-input' && (
        <>
          {items.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-3">
              {items.map((item) => (
                <button
                  key={item.key}
                  onClick={item.onItemClick}
                  className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-full cursor-pointer bg-surface-active text-foreground-secondary border border-border-subtle hover:text-foreground hover:border-border"
                >
                  {item.icon}
                  {item.title}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 p-3">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && input.trim()) submit() }}
              placeholder="Send message to AI writing..."
              className="flex-1 min-w-0 text-xs bg-background border border-border rounded-md px-2.5 py-1.5 text-foreground placeholder:text-muted outline-none focus:border-accent"
            />
            <button
              onClick={submit}
              disabled={!input.trim()}
              aria-label="Send prompt"
              className="flex h-7 w-7 items-center justify-center rounded-md cursor-pointer bg-accent text-white border-none disabled:opacity-35 disabled:cursor-not-allowed hover:bg-accent-hover shrink-0"
            >
              <ArrowUp size={13} />
            </button>
          </div>
        </>
      )}

      {(status === 'thinking' || status === 'ai-writing') && (
        <div className="flex items-center justify-between gap-2 px-3 py-3">
          <span className="flex items-center gap-2 text-xs text-foreground-secondary">
            <Loader2 size={13} className="animate-spin text-accent" />
            {status === 'thinking' ? 'Thinking…' : 'Writing…'}
          </span>
          <button onClick={() => ai.abort?.('stopped by user').catch(() => {})} className="text-[11px] px-2 py-1 rounded cursor-pointer bg-surface-active border border-border-subtle text-foreground-secondary hover:text-foreground">
            Stop
          </button>
        </div>
      )}

      {status === 'user-reviewing' && (
        <div className="flex items-center justify-end gap-2 px-3 py-3">
          <span className="text-xs text-foreground-secondary mr-auto">Review the changes</span>
          <button onClick={() => ai.rejectChanges()} className="text-[11px] px-2.5 py-1 rounded cursor-pointer bg-surface-active border border-border-subtle text-foreground-secondary hover:text-foreground">
            Revert
          </button>
          <button onClick={() => ai.acceptChanges()} className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded cursor-pointer bg-accent text-white border-none hover:bg-accent-hover">
            <Check size={11} />
            Accept
          </button>
        </div>
      )}

      {status === 'error' && (
        <div className="px-3 py-3">
          <div className="text-[11px] text-danger mb-2 break-words">
            {typeof aiMenu !== 'string' && aiMenu.error ? String(aiMenu.error?.message ?? aiMenu.error) : 'Something went wrong'}
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => ai.rejectChanges()} className="text-[11px] px-2.5 py-1 rounded cursor-pointer bg-surface-active border border-border-subtle text-foreground-secondary hover:text-foreground">
              Cancel
            </button>
            <button onClick={() => ai.retry()?.catch(() => {})} className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded cursor-pointer bg-accent text-white border-none hover:bg-accent-hover">
              <RotateCcw size={11} />
              Retry
            </button>
          </div>
        </div>
      )}
    </div>
  )
}