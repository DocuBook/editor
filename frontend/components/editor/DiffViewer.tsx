/** Read-only inline diff for a changed file, opened from the Changes panel.
 *
 *  Rendered in the editor surface — like the image/text previews — instead of a
 *  modal, so a diff is just another way a file opens. The before/after text comes
 *  from `git_diff_file`; the line diff is computed locally (utils/lineDiff), so no
 *  diff dependency is added. */
import { useEffect, useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import { invoke } from '../../lib/ipc'
import { lineDiff, type DiffRow } from '../../utils/lineDiff'

type DiffState =
  | { status: 'loading' }
  | { status: 'ready'; rows: DiffRow[] }
  | { status: 'error'; message: string }

/** Callout look per line: a tinted surface with a coloured left rule — red for a
 *  deletion, green for an insertion — so a change reads as a block, not just
 *  coloured text. Context/gap rows keep the rule transparent so every line stays
 *  aligned on the same left edge. */
const ROW_CLASS: Record<DiffRow['type'], string> = {
  add: 'border-success bg-success-surface text-success',
  del: 'border-danger bg-danger-surface text-danger',
  context: 'border-transparent text-foreground-secondary',
  gap: 'border-transparent text-muted',
}
/** The callout's leading icon — the +/- that marks which side a line is on. */
const ROW_ICON: Partial<Record<DiffRow['type'], typeof Plus>> = { add: Plus, del: Minus }
/** Solid accent rail holding the sign icon. Same colour as the row's left rule,
 *  flush against it and full-height, so the rule and the +/- read as one block
 *  rather than a bar sitting next to a floating icon. Context/gap rows reserve
 *  the same width (transparent) to keep every line's text on one edge. */
const ROW_RAIL: Record<DiffRow['type'], string> = {
  add: 'bg-success text-on-accent',
  del: 'bg-danger text-on-accent',
  context: 'bg-transparent',
  gap: 'bg-transparent',
}

/** Separator for a collapsed run of unchanged lines — not a real file line. */
const GAP_SIGN = '⋯'

export function DiffViewer({ path, name, staged }: { path: string; name: string; staged: boolean }) {
  const [state, setState] = useState<DiffState>({ status: 'loading' })

  /* oxlint-disable react/set-state-in-effect -- reset to a loading view when the diff target changes */
  useEffect(() => {
    let alive = true
    setState({ status: 'loading' })
    invoke<string>('git_diff_file', { path, staged })
      .then(raw => {
        if (!alive) return
        const parsed = JSON.parse(raw) as { old?: string; new?: string }
        setState({ status: 'ready', rows: lineDiff(parsed.old ?? '', parsed.new ?? '') })
      })
      .catch(error => { if (alive) setState({ status: 'error', message: String(error) }) })
    return () => { alive = false }
  }, [path, staged])
  /* oxlint-enable react/set-state-in-effect */

  const changed = state.status === 'ready' ? state.rows.filter(row => row.type === 'add' || row.type === 'del').length : 0

  return (
    <div className="diff-writing-column text-sm">
      <div className="mb-4 flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-muted">
        <span className="min-w-0 truncate">{name}</span>
        <span className="shrink-0 rounded border border-border-subtle px-1.5 py-0.5 normal-case tracking-normal">{staged ? 'staged' : 'unstaged'}</span>
        {state.status === 'ready' && <span className="shrink-0 normal-case tracking-normal">{changed} changed line{changed === 1 ? '' : 's'}</span>}
      </div>
      {state.status === 'loading' && <div className="italic text-foreground-subtle">Loading diff…</div>}
      {state.status === 'error' && <div role="alert" className="wrap-break-word text-danger">{state.message}</div>}
      {state.status === 'ready' && (state.rows.length === 0
        ? <div className="italic text-foreground-subtle">No changes.</div>
        : (
          <div data-testid="diff-body" className="font-mono leading-relaxed">
            {state.rows.map((row, index) => {
              const Icon = ROW_ICON[row.type]
              return (
                <div
                  key={index}
                  className={'flex border-l-2 ' + ROW_CLASS[row.type]}
                >
                  <span
                    className={'flex w-6 shrink-0 items-center justify-center ' + ROW_RAIL[row.type]}
                    aria-hidden="true"
                  >
                    {Icon ? <Icon size={12} strokeWidth={3} /> : row.type === 'gap' ? GAP_SIGN : null}
                  </span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap px-3 py-1">{row.text || ' '}</span>
                </div>
              )
            })}
          </div>
        ))}
    </div>
  )
}
