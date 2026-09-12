import { useMemo } from 'react'
import { Check, File, GitBranch, GitMerge, RefreshCw } from 'lucide-react'
import { useGitStatus, pollGitStatus } from '../../stores/gitStatus'
import { useEditorStore } from '../../stores/editor'

interface GitEntry {
  x: string
  y: string
  path: string
}

const parseStatus = (status: string): GitEntry[] => status
  .split('\n')
  .map(line => line.replace(/\s+$/, ''))
  .filter(line => line.length >= 4)
  .map(line => ({ x: line[0], y: line[1], path: line.slice(3).trim() }))
  .filter(entry => entry.path.length > 0)

const statusLabel = (entry: GitEntry) => {
  const code = entry.y !== '.' ? entry.y : entry.x
  if (code === '?') return 'U'
  return code || 'M'
}

function ChangeRow({ entry, staged }: { entry: GitEntry; staged: boolean }) {
  const openFile = useEditorStore(state => state.openFile)
  const name = entry.path.split('/').pop() || entry.path
  const folder = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''

  return (
    <button
      type="button"
      onClick={() => void openFile(entry.path, name)}
      title={entry.path}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left cursor-pointer hover:bg-surface-active"
    >
      <span className={'flex size-5 shrink-0 items-center justify-center rounded text-[10px] font-mono ' + (staged ? 'bg-success-surface text-success' : 'bg-warning-surface text-warning')}>
        {statusLabel(entry)}
      </span>
      <File size={12} className="shrink-0 text-foreground-subtle" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] text-foreground-secondary">{name}</span>
        {folder && <span className="block truncate text-[9px] text-muted">{folder}</span>}
      </span>
      {staged && <Check size={12} className="shrink-0 text-success" />}
    </button>
  )
}

export default function GitPanel() {
  const { isRepo, branch, status, ahead, behind } = useGitStatus()
  const entries = useMemo(() => parseStatus(status), [status])
  const changes = entries.filter(entry => entry.y !== '.')
  const staged = entries.filter(entry => entry.x !== '.' && entry.x !== '?')

  return (
    <section aria-label="Git Panel" className="flex min-h-0 flex-1 flex-col text-xs">
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <GitBranch size={13} className="shrink-0 text-foreground-subtle" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground-secondary">{branch || 'no branch'}</span>
        {ahead > 0 && <span className="text-[10px] text-muted">↑{ahead}</span>}
        {behind > 0 && <span className="text-[10px] text-muted">↓{behind}</span>}
        <button
          type="button"
          onClick={() => void pollGitStatus()}
          aria-label="Refresh git changes"
          title="Refresh"
          className="rounded p-1 text-foreground-subtle cursor-pointer hover:bg-surface-active hover:text-foreground"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!isRepo && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-foreground-subtle">
            <GitMerge size={20} />
            <span>Vault is not a git repository.</span>
          </div>
        )}
        {isRepo && entries.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-foreground-subtle">
            <Check size={20} className="text-success" />
            <span>Working tree is clean.</span>
          </div>
        )}
        {isRepo && changes.length > 0 && (
          <section className="mb-3">
            <div className="mb-1 px-1 text-[10px] uppercase tracking-wider text-muted">Changes ({changes.length})</div>
            {changes.map(entry => <ChangeRow key={`change:${entry.path}`} entry={entry} staged={false} />)}
          </section>
        )}
        {isRepo && staged.length > 0 && (
          <section>
            <div className="mb-1 px-1 text-[10px] uppercase tracking-wider text-muted">Staged ({staged.length})</div>
            {staged.map(entry => <ChangeRow key={`staged:${entry.path}`} entry={entry} staged />)}
          </section>
        )}
      </div>
    </section>
  )
}
