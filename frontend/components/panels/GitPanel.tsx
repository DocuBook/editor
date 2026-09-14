import { useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, File, GitBranch, GitMerge, RefreshCw } from 'lucide-react'
import { invoke } from '../../lib/ipc'
import { useGitStatus, pollGitStatus } from '../../stores/gitStatus'
import { useEditorStore } from '../../stores/editor'
import { useVaultStore } from '../../stores/vault'

interface GitEntry {
  x: string
  y: string
  path: string
}

interface SyncOutcome { success: boolean; message: string; error: string; conflicts: string[] }

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

/** Porcelain marks conflicts with a `U` (unmerged) on either side, but the
 *  backend maps some conflict states through their index flag first — an
 *  add/add conflict arrives as `AA`. Every combination that contains a `U`, plus
 *  the `AA`/`DD` pairs, is unmerged work, so it belongs in Conflicts only. */
const conflictOf = (entry: GitEntry) =>
  entry.x === 'U' || entry.y === 'U' ||
  (entry.x === entry.y && (entry.x === 'A' || entry.x === 'D'))

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

/** A conflicted path stays unstaged until git is told the resolution is final
 *  — the row keeps the file-open behaviour and adds an explicit Stage action. */
function ConflictRow({ entry, onStage, disabled }: { entry: GitEntry; onStage: (path: string) => void; disabled: boolean }) {
  const openFile = useEditorStore(state => state.openFile)
  const name = entry.path.split('/').pop() || entry.path
  const folder = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''

  return (
    <div className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-surface-active">
      <button
        type="button"
        onClick={() => void openFile(entry.path, name)}
        title={entry.path}
        className="flex min-w-0 flex-1 items-center gap-2 bg-transparent border-none p-0 text-left cursor-pointer text-foreground-secondary hover:text-foreground"
      >
        <span className="flex size-5 shrink-0 items-center justify-center rounded bg-danger-surface text-[10px] font-mono text-danger">U</span>
        <File size={12} className="shrink-0 text-foreground-subtle" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px]">{name}</span>
          {folder && <span className="block truncate text-[9px] text-muted">{folder}</span>}
        </span>
      </button>
      <button
        type="button"
        onClick={() => onStage(entry.path)}
        disabled={disabled}
        aria-label={`Stage ${entry.path}`}
        title="Mark the conflicted file as resolved (stage it)"
        className="shrink-0 rounded border-none bg-surface-hover px-2 py-0.5 text-[10px] text-foreground-secondary cursor-pointer whitespace-nowrap hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Stage
      </button>
    </div>
  )
}

/** Remote sync actions. Conflicts are never resolved silently: a merge leaves
 *  the worktree for Commit, a rebase is kept on disk for Continue/Abort. */
function SyncBar() {
  const { hasRemote, hasCommits, upstream, pushTarget = '', remotes = [], repoState = 'clean' } = useGitStatus()
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmAbort, setConfirmAbort] = useState<'merge' | 'rebase' | null>(null)
  const abortRef = useRef<HTMLDivElement>(null)

  const rebasing = repoState.startsWith('rebase')
  const merging = repoState === 'merge'
  const inProgress = repoState !== 'clean'
  /** A state left behind by a hand-run git command is not reproducible here, so
   *  it gets guidance instead of Continue/Abort controls. */
  const foreignState = inProgress && !rebasing && !merging
  /** A stored selection can outlive the remote it named — falling back to the
   *  push target keeps the panel usable instead of stranding it on a dead name. */
  const isSelectable = remotes.includes(selected)
  const activeRemote = isSelectable ? selected : pushTarget || remotes[0] || ''
  /** Only follow the upstream branch when it belongs to the selected remote;
   *  otherwise the backend resolves the remote's own default branch. */
  const targetBranch = upstream && activeRemote && upstream.startsWith(`${activeRemote}/`)
    ? upstream.slice(activeRemote.length + 1)
    : ''
  const targetLabel = activeRemote ? `${activeRemote}/${targetBranch || 'default branch'}` : 'no remote'

  const run = async (label: string, action: () => Promise<string | undefined>) => {
    setBusy(label); setErr(''); setNotice('')
    try { await action() }
    catch (e) { setErr(String(e)) } finally { setBusy('') }
  }

  const afterSync = async () => {
    await pollGitStatus()
    await useVaultStore.getState().loadTree().catch(() => {})
  }

  const report = (outcome: SyncOutcome) => {
    if (outcome.error) { setErr(outcome.error); return false }
    if (outcome.conflicts.length > 0) {
      setNotice(`${outcome.message}: ${outcome.conflicts.join(', ')}`)
      return false
    }
    setNotice(outcome.message)
    return true
  }

  const fetchRemote = () => run('fetch', async () => {
    await invoke('git_fetch', { name: activeRemote })
    setNotice(`Fetched ${activeRemote}`)
    await pollGitStatus()
  })

  const mergeRemote = () => run('merge', async () => {
    await invoke('git_fetch', { name: activeRemote })
    report(JSON.parse(await invoke<string>('git_remote_merge', { name: activeRemote, branch: targetBranch })))
    await afterSync()
  })

  const rebaseRemote = () => run('rebase', async () => {
    await invoke('git_fetch', { name: activeRemote })
    report(JSON.parse(await invoke<string>('git_rebase', { name: activeRemote, branch: targetBranch })))
    await afterSync()
  })

  const continueRebase = () => run('continue', async () => {
    report(JSON.parse(await invoke<string>('git_rebase_continue')))
    await afterSync()
  })

  const abort = () => run('abort', async () => {
    const which = confirmAbort
    setConfirmAbort(null)
    await invoke(which === 'merge' ? 'git_merge_abort' : 'git_rebase_abort')
    setNotice(which === 'merge' ? 'Merge aborted' : 'Rebase aborted')
    await afterSync()
  })

  const btn = 'rounded px-2 py-1 text-[11px] cursor-pointer border-none bg-surface-hover text-foreground-secondary hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap'
  const idle = !inProgress && !!activeRemote && hasRemote
  /** Keep the pre-existing escape hatch even though Cancel holds focus by
   *  default: a modal that cannot be dismissed from the keyboard is a trap. */
  const cancelAbort = () => {
    setConfirmAbort(null)
    abortRef.current?.focus()
  }

  return (
    <div className="border-b border-border-subtle px-3 py-2 text-[11px]">
      <div className="flex flex-wrap items-center gap-1.5">
        {remotes.length > 1 && (
          <select
            aria-label="Sync remote"
            value={activeRemote}
            onChange={e => setSelected(e.target.value)}
            disabled={inProgress}
            className="rounded border border-border-subtle bg-background px-1 py-1 text-[11px] font-mono text-foreground outline-none"
          >
            {remotes.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        )}
        {rebasing || merging ? (
          <>
            {rebasing && <button type="button" className={btn} onClick={continueRebase} disabled={busy !== ''}>Continue</button>}
            <button type="button" className={btn} onClick={() => setConfirmAbort(rebasing ? 'rebase' : 'merge')} disabled={busy !== ''}>Abort</button>
          </>
        ) : (
          <>
            <button type="button" className={btn} onClick={fetchRemote} disabled={!idle || busy !== ''}>{busy === 'fetch' ? 'Fetching…' : 'Fetch'}</button>
            <button
              type="button"
              className={btn}
              onClick={rebaseRemote}
              disabled={!idle || !hasCommits || busy !== ''}
              title={hasCommits ? undefined : 'No local commits yet — Merge brings in the remote branch instead'}
            >
              {busy === 'rebase' ? 'Rebasing…' : 'Rebase'}
            </button>
            <button type="button" className={btn} onClick={mergeRemote} disabled={!idle || busy !== ''}>{busy === 'merge' ? 'Merging…' : 'Merge'}</button>
          </>
        )}
        <span className="ml-auto truncate font-mono text-[10px] text-muted">{targetLabel}</span>
      </div>

      {merging && (
        <div className="mt-1.5 text-[10px] text-warning">Merge in progress — resolve the conflicted files below, stage them, then use Commit in the Actions menu.</div>
      )}
      {rebasing && (
        <div className="mt-1.5 text-[10px] text-warning">Rebase in progress — resolve the conflicted files below, stage them, then Continue.</div>
      )}
      {foreignState && (
        <div className="mt-1.5 text-[10px] text-warning">
          A {repoState} is in progress — finish or abort it with system Git. Fetch, Rebase, and Merge stay disabled until the repository is clean again.
        </div>
      )}
      {!inProgress && remotes.length > 1 && (
        <div className="mt-1.5 text-[10px] text-muted">Several remotes — pick the one to sync with. Push still follows the branch upstream.</div>
      )}
      {notice && <div className="mt-1.5 text-[10px] text-foreground-secondary">{notice}</div>}
      {err && <div className="mt-1.5 text-[10px] text-danger">{err}</div>}

      {confirmAbort && (
        <div role="alertdialog" aria-modal="true" aria-label="Abort in-progress operation" tabIndex={-1} ref={abortRef} className="fixed inset-0 z-220 flex items-center justify-center bg-overlay outline-none" onClick={cancelAbort} onKeyDown={e => { if (e.key === 'Escape') cancelAbort() }}>
          <div className="ui-popover p-4 w-80" onClick={e => e.stopPropagation()}>
            <div className="text-sm font-semibold mb-1">Abort the {confirmAbort}?</div>
            <div className="text-xs text-foreground-secondary mb-4">Every uncommitted change made during the {confirmAbort} is discarded — resolved and unresolved files alike, staged or not — and the branch returns to its previous state.</div>
            <div className="flex justify-end gap-2">
              <button autoFocus onClick={cancelAbort} className="text-xs px-3 py-1.5 rounded border border-border-subtle bg-transparent text-foreground-secondary cursor-pointer hover:bg-surface-active">Cancel</button>
              <button onClick={() => void abort()} className="text-xs px-3 py-1.5 rounded bg-danger text-on-danger cursor-pointer border-none">Abort</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function GitPanel() {
  const { isRepo, branch, status, ahead, behind } = useGitStatus()
  const [staging, setStaging] = useState('')
  const [stageError, setStageError] = useState('')
  const entries = useMemo(() => parseStatus(status), [status])
  /** Merging leaves a path with both an unresolved index entry and a worktree
   *  copy, so a conflicted path must live in exactly one group — never in both,
   *  where it would read as already staged. */
  const conflicts = entries.filter(conflictOf)
  const changes = entries.filter(entry => !conflictOf(entry) && entry.y !== '.')
  const staged = entries.filter(entry => !conflictOf(entry) && entry.x !== '.' && entry.x !== '?')

  /** Staging is what tells git a conflict is resolved, so the row gets its own
   *  action instead of a second click target on the file-open button. */
  const stageConflict = async (path: string) => {
    setStaging(path)
    setStageError('')
    try { await invoke('git_stage', { path }) }
    catch (error) { setStageError(String(error)) }
    finally {
      setStaging('')
      await pollGitStatus()
    }
  }

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

      {isRepo && <SyncBar />}

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
        {isRepo && conflicts.length > 0 && (
          <section className="mb-3">
            <div className="mb-1 px-1 text-[10px] uppercase tracking-wider text-danger">Conflicts ({conflicts.length})</div>
            {conflicts.map(entry => (
              <ConflictRow key={`conflict:${entry.path}`} entry={entry} onStage={stageConflict} disabled={staging === entry.path} />
            ))}
            {stageError && <div role="alert" className="mt-1 px-1 text-[10px] text-danger wrap-break-word">{stageError}</div>}
            <div className="mt-1 flex items-start gap-1.5 px-1 text-[10px] text-muted">
              <AlertTriangle size={11} className="mt-px shrink-0 text-warning" />
              <span>Edit each file to resolve it, then Stage it. Nothing here counts as staged until you do.</span>
            </div>
          </section>
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
