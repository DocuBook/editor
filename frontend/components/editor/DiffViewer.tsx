/** Read-only inline diff for a changed file, opened from the Changes panel.
 *
 *  Rendered in the editor surface — like the image/text previews — instead of a
 *  modal, so a diff is just another way a file opens. The before/after text comes
 *  from `git_diff_file`; the line diff is computed locally (utils/lineDiff), so no
 *  diff dependency is added. */
import { useEffect, useState } from 'react'
import { invoke } from '../../lib/ipc'
import { lineDiff, type DiffRow } from '../../utils/lineDiff'

type DiffState =
  | { status: 'loading' }
  | { status: 'ready'; rows: DiffRow[] }
  | { status: 'error'; message: string }

const ROW_CLASS: Record<DiffRow['type'], string> = {
  add: 'text-success',
  del: 'text-danger',
  context: 'text-foreground-secondary',
  gap: 'text-muted',
}
const ROW_SIGN: Record<DiffRow['type'], string> = { add: '+', del: '-', context: ' ', gap: '' }

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
    <div className="text-sm">
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
          <div data-testid="diff-body" className="font-mono leading-relaxed whitespace-pre-wrap">
            {state.rows.map((row, index) => (
              <div key={index} className={ROW_CLASS[row.type]}>
                {row.type === 'gap' ? GAP_SIGN : `${ROW_SIGN[row.type]} ${row.text || ' '}`}
              </div>
            ))}
          </div>
        ))}
    </div>
  )
}
