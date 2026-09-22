import { AlertTriangle } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { Conflict } from '../stores/sync'

/** Line-level diff for the two sides of a conflict.
 *
 *  A full Myers diff would be nicer, but a line-set comparison answers the only
 *  question the user actually has here — "what did they change that I don't
 *  have, and vice versa" — without a dependency. Duplicate lines make it an
 *  approximation, which is acceptable for a read-only preview. */
function splitLines(text: string): string[] {
  return text.split('\n')
}

function diffLines(mine: string, theirs: string) {
  const mineLines = splitLines(mine)
  const theirsLines = splitLines(theirs)
  const mineCounts = new Map<string, number>()
  for (const line of mineLines) mineCounts.set(line, (mineCounts.get(line) ?? 0) + 1)

  return {
    mine: mineLines.map(line => ({ line, changed: (mineCounts.get(line) ?? 0) > 0 && !theirsLines.includes(line) })),
    theirs: theirsLines.map(line => ({ line, changed: !mineLines.includes(line) })),
  }
}

interface ConflictDialogProps {
  conflict: Conflict
  onResolve: (choice: 'mine' | 'theirs') => void
  onClose: () => void
}

/** Shown when a save was rejected because the file changed on disk.
 *
 *  The dialog shows both versions and requires the user to explicitly choose
 *  which version to keep, or defer the decision without discarding either side. */
export default function ConflictDialog({ conflict, onResolve, onClose }: ConflictDialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mineRef = useRef<HTMLButtonElement>(null)
  const diff = useMemo(() => diffLines(conflict.mine, conflict.theirs), [conflict.mine, conflict.theirs])

  useEffect(() => { mineRef.current?.focus() }, [conflict.path])

  const run = (choice: 'mine' | 'theirs') => {
    setBusy(true)
    setError('')
    // Resolution touches disk, so a failure must keep the dialog open rather
    // than closing on an action that silently did nothing.
    void Promise.resolve()
      .then(() => onResolve(choice))
      .catch(e => setError(String(e)))
      .finally(() => setBusy(false))
  }

  const fileName = conflict.path.split('/').pop() || conflict.path

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Resolve file conflict"
      className="fixed inset-0 z-220 flex items-center justify-center bg-overlay"
      onClick={onClose}
      onKeyDown={e => { if (e.key === 'Escape') onClose() }}
    >
      <div className="ui-popover p-4 w-2xl max-w-[90vw]" onClick={e => e.stopPropagation()}>
        <div className="mb-2 flex items-center gap-2">
          <AlertTriangle size={16} className="shrink-0 text-danger" />
          <div className="text-sm font-semibold">“{fileName}” changed on disk</div>
        </div>
        <div className="mb-3 text-xs text-foreground-secondary">
          Your edit was not saved, because another change to this file arrived first. Nothing has been overwritten —
          pick which version to keep.
        </div>

        <div className="mb-4 grid grid-cols-2 gap-3">
          {([['Your version', diff.mine, false], ['On disk', diff.theirs, true]] as const).map(([label, lines, isDisk]) => (
            <div key={label} className="min-w-0">
              <div className="mb-1 text-[11px] font-medium text-foreground-secondary">{label}</div>
              <div
                data-testid={isDisk ? 'conflict-theirs' : 'conflict-mine'}
                className="max-h-64 overflow-auto rounded border border-border-subtle bg-surface p-2 text-[11px] font-mono leading-5"
              >
                {lines.length === 1 && lines[0].line === '' ? (
                  <span className="text-muted">(empty file)</span>
                ) : lines.map((l, i) => (
                  <div key={i} className={l.changed ? 'bg-accent-subtle text-foreground' : 'text-foreground-secondary'}>
                    {l.line === '' ? '\u00a0' : l.line}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {error && <div role="alert" className="mb-3 text-[11px] text-danger">Could not resolve this conflict. {error}</div>}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded border border-border-subtle bg-transparent text-foreground-secondary cursor-pointer hover:bg-surface-active">Decide later</button>

          <button
            disabled={busy}
            onClick={() => run('theirs')}
            className="text-xs px-3 py-1.5 rounded border border-border-subtle bg-transparent text-foreground-secondary cursor-pointer hover:bg-surface-active disabled:opacity-50"
          >
            Use the disk version
          </button>
          <button
            ref={mineRef}
            disabled={busy}
            onClick={() => run('mine')}
            className="text-xs px-3 py-1.5 rounded bg-accent text-on-accent cursor-pointer border-none hover:bg-accent-hover disabled:opacity-50"
          >
            Keep my version
          </button>
        </div>
      </div>
    </div>
  )
}
