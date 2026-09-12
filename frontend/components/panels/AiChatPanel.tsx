import { useEffect, useMemo, useRef } from 'react'
import { BotMessageSquare, ChevronRight, Loader2, X } from 'lucide-react'
import { useAiThreads } from '../../stores/aiThreads'

const timeLabel = (value: number) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value)

export default function AiChatPanel() {
  const { threads, activeThreadId, setActiveThread, removeThread } = useAiThreads()
  const ordered = useMemo(() => threads.filter(thread => thread.messages.length > 0).sort((a, b) => b.updatedAt - a.updatedAt), [threads])
  const active = ordered.find(thread => thread.id === activeThreadId)
  const lastMessageContent = active && active.messages.length > 0 ? active.messages[active.messages.length - 1].content : ''
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [active?.id, active?.messages.length, lastMessageContent])

  return (
    <section aria-label="AI Chat" className="flex min-h-0 flex-1 flex-col text-xs">
      <div className="shrink-0 border-b border-border-subtle px-3 py-2">
        <span className="font-medium text-foreground-secondary">Threads ({ordered.length})</span>
      </div>

      {ordered.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-foreground-subtle">
          <BotMessageSquare size={20} />
          <span>No AI threads yet.</span>
          <span className="text-[10px] text-muted">Use the editor AI composer to start one.</span>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {ordered.map(thread => {
            const expanded = thread.id === active?.id
            const contentId = `ai-thread-${thread.id}`
            return (
              <article key={thread.id} className="group mb-1 overflow-hidden rounded-lg border border-border-subtle bg-background">
                <div className={expanded ? 'flex items-center bg-surface-active' : 'flex items-center hover:bg-surface-hover'}>
                  <button
                    type="button"
                    onClick={() => setActiveThread(expanded ? null : thread.id)}
                    aria-expanded={expanded}
                    aria-controls={contentId}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left text-foreground-secondary cursor-pointer"
                  >
                    <ChevronRight size={12} className={'shrink-0 text-muted transition-transform ' + (expanded ? 'rotate-90' : '')} />
                    <BotMessageSquare size={13} className="shrink-0 text-foreground-subtle" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium text-foreground">{thread.title}</span>
                      <span className="block truncate text-[9px] text-muted">{thread.filePath || timeLabel(thread.updatedAt)}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => removeThread(thread.id)}
                    aria-label={`Delete thread ${thread.title}`}
                    title="Delete thread"
                    className="mr-1 rounded p-1 text-muted opacity-0 cursor-pointer group-hover:opacity-100 hover:bg-background hover:text-danger focus-visible:opacity-100"
                  >
                    <X size={11} />
                  </button>
                </div>

                {expanded && (
                  <div id={contentId} className="border-t border-border-subtle bg-surface p-2">
                    <div className="mb-2 text-[9px] text-muted">{timeLabel(thread.updatedAt)}</div>
                    {thread.messages.map(message => (
                      <div
                        key={message.id}
                        className={
                          'mb-2 rounded-lg border px-2.5 py-2 ' +
                          (message.role === 'user'
                            ? 'ml-3 border-border-subtle bg-background text-foreground-secondary'
                            : 'mr-3 border-border bg-surface-hover text-foreground')
                        }
                      >
                        <div className="mb-1 flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-muted">
                          <span>{message.role === 'user' ? 'Prompt' : 'AI'}</span>
                          {message.status === 'streaming' && <Loader2 size={10} className="animate-spin text-accent" />}
                          {message.status === 'error' && <span className="text-danger">Failed</span>}
                        </div>
                        <div className="whitespace-pre-wrap wrap-break-word leading-relaxed">
                          {message.content || (message.status === 'streaming' ? 'Thinking…' : 'No response recorded')}
                        </div>
                      </div>
                    ))}
                    <div ref={endRef} />
                  </div>
                )}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
