import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, File, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest, PencilSparkles, RefreshCw, Upload } from 'lucide-react'
import { invoke } from '../../lib/ipc'
import { useGitStatus, pollGitStatus } from '../../stores/gitStatus'
import { useGitOperation, withGitOperation } from '../../stores/gitOperation'
import { useEditorStore } from '../../stores/editor'
import { useVaultStore } from '../../stores/vault'
import { useClickOutside } from '../../hooks/useClickOutside'
import SidebarPopover from '../SidebarPopover'
import OverlayPortal from '../OverlayPortal'
import { autoCommitMessage } from '../../utils/commitMessage'
import { toast } from 'sonner'

interface GitEntry {
  x: string
  y: string
  path: string
}

interface BranchEntry { name: string; remote: boolean }

function BranchSwitcher({ branch, open, onToggle }: { branch: string; open: boolean; onToggle: () => void }) {
  const [branches, setBranches] = useState<BranchEntry[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const gitActive = useGitOperation(state => state.active)
  const [newBranchName, setNewBranchName] = useState('')
  const [error, setError] = useState('')

  const toggle = async () => {
    onToggle()
    if (open) return
    setError('')
    setNewBranchName('')
    try {
      const result = await invoke<unknown>('git_branches')
      const parsed = typeof result === 'string' ? JSON.parse(result) : result
      setBranches(Array.isArray(parsed) ? parsed.filter((entry: any) => entry && typeof entry.name === 'string') : [])
    } catch (e) { setError(String(e)) }
  }

  const checkout = async (entry: BranchEntry, create = false) => {
    if (busy || gitActive || (!create && entry.name === branch)) return
    setBusy(entry.name)
    setError('')
    try {
      const dirty = useEditorStore.getState().tabs.filter(tab => tab.dirty).length
      await withGitOperation('branch switch', async () => {
        await invoke(create ? 'git_create_branch' : 'git_checkout', create ? { branch: entry.name } : { branch: entry.name, remote: entry.remote })
        onToggle()
        await useEditorStore.getState().reloadAllTabs()
        // The other branch can add or remove files — refresh the sidebar tree too.
        await useVaultStore.getState().loadTree().catch(() => {})
      })
      void pollGitStatus()
      toast.success((create ? 'Created and switched to ' : 'Switched to ') + entry.name + (dirty ? ` — ${dirty} unsaved tab${dirty > 1 ? 's' : ''} kept open` : ''))
    } catch (e) { setError(String(e)) }
    finally { setBusy(null) }
  }

  const groups = [
    ['Local', branches.filter(entry => !entry.remote)],
    ['Remote', branches.filter(entry => entry.remote)],
  ] as const

  return (
    <span className="min-w-0 flex-1">

      <button type="button" onClick={() => void toggle()} aria-label="Switch branch" aria-expanded={open} title="Switch branch"
        className="flex min-w-0 max-w-full items-center gap-1 rounded border-none bg-transparent px-1 py-1 text-left text-foreground-secondary hover:bg-surface-active hover:text-foreground cursor-pointer">
        <GitBranch size={13} className="shrink-0 text-foreground-subtle" />
        <span className="min-w-0 truncate font-mono text-[11px]">{branch || 'no branch'}</span>
        <ChevronDown size={11} className={'shrink-0 text-muted transition-transform ' + (open ? 'rotate-180' : '')} />
      </button>
      {open && <SidebarPopover side="bottom">
        <form onSubmit={e => { e.preventDefault(); const name = newBranchName.trim(); if (name) void checkout({ name, remote: false }, true) }} className="px-2 py-1.5 border-b border-border-subtle">
          <input autoFocus value={newBranchName} onChange={e => setNewBranchName(e.target.value)} disabled={busy !== null || !!gitActive} placeholder="Type to create a branch..." aria-label="Create branch" className="w-full min-w-0 bg-transparent border-none outline-none text-[12px] text-foreground placeholder:text-muted" />
        </form>
        <div className="max-h-[min(16rem,calc(100dvh-9rem))] overflow-y-auto py-1">
          {groups.map(([label, entries]) => entries.length > 0 && <section key={label}>
            <div className="px-2.5 pt-1.5 pb-1 text-[10px] uppercase tracking-wider text-foreground-subtle">{label}</div>
            {entries.map(entry => <button type="button" key={entry.name} onClick={() => void checkout(entry)} disabled={busy !== null || !!gitActive} className="flex w-full items-center gap-2 rounded border-none bg-transparent px-2.5 py-1.5 text-left text-[12px] text-foreground-secondary hover:bg-surface-active disabled:opacity-50">
              <GitBranch size={11} className="shrink-0 text-foreground-subtle" /><span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {entry.name === branch && <Check size={12} className="shrink-0 text-accent" />}
              {busy === entry.name && <span className="shrink-0 text-[10px] text-muted">switching…</span>}
            </button>)}
          </section>)}
          {branches.length === 0 && !error && <div className="px-2.5 py-2 text-[11px] text-muted">No branches found</div>}
          {error && <div className="px-2.5 py-1 text-[10px] text-danger wrap-break-word">{error}</div>}
        </div>
      </SidebarPopover>}
    </span>
  )
}

interface SyncOutcome { success: boolean; message: string; error: string; conflicts: string[] }
interface PullOutcome extends SyncOutcome {
  state: 'upToDate' | 'fastForwarded' | 'adopted' | 'rebased' | 'merged' | 'conflicts' | 'failed'
  strategy: 'none' | 'fastForward' | 'rebase' | 'merge'
  remote: string
  branch: string
  remoteChanged: boolean
  ahead: number
  behind: number
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

/** Porcelain marks conflicts with a `U` (unmerged) on either side, but the
 *  backend maps some conflict states through their index flag first — an
 *  add/add conflict arrives as `AA`. Every combination that contains a `U`, plus
 *  the `AA`/`DD` pairs, is unmerged work, so it belongs in Conflicts only. */
const conflictOf = (entry: GitEntry) =>
  entry.x === 'U' || entry.y === 'U' ||
  (entry.x === entry.y && (entry.x === 'A' || entry.x === 'D'))

function ChangeRow({ entry, staged }: { entry: GitEntry; staged: boolean }) {
  const openDiff = useEditorStore(state => state.openDiff)
  const name = entry.path.split('/').pop() || entry.path
  const folder = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''

  return (
    <button
      type="button"
      onClick={() => void openDiff(entry.path, name, staged)}
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
 *  — the row opens the worktree-vs-index diff and adds an explicit Stage action. */
function ConflictRow({ entry, onStage, disabled }: { entry: GitEntry; onStage: (path: string) => void; disabled: boolean }) {
  const openDiff = useEditorStore(state => state.openDiff)
  const name = entry.path.split('/').pop() || entry.path
  const folder = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''

  return (
    <div className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-surface-active">
      <button
        type="button"
        onClick={() => void openDiff(entry.path, name, false)}
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
  const { branch, upstream = '', ahead = 0, behind = 0, hasRemote, hasCommits, pushTarget = '', remotes = [], repoState = 'clean' } = useGitStatus()
  const [selected, setSelected] = useState('')
  const [activePopover, setActivePopover] = useState<'branch' | 'actions' | null>(null)
  const syncOpen = activePopover === 'actions'
  const [syncState, setSyncState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const gitActive = useGitOperation(state => state.active)
  const [activeAction, setActiveAction] = useState('')
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmAbort, setConfirmAbort] = useState<'merge' | 'rebase' | null>(null)
  const syncRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<HTMLDivElement>(null)
  useClickOutside(syncRef, () => setActivePopover(null))

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
  /** Sidebar branch picker and this panel consume the same store field. */
  const localBranch = branch && !branch.startsWith('(') ? branch : ''
  /** `behind` is counted against the configured upstream, so sync targets it
   *  when it lives on the selected remote (`dev` tracking `origin/develop`).
   *  Any other remote gets the same-named branch — never its default branch. */
  const targetBranch = localBranch && activeRemote && upstream.startsWith(`${activeRemote}/`)
    ? upstream.slice(activeRemote.length + 1)
    : localBranch
  const busy = syncState === 'busy'
  /** Any git operation — this bar's own or a commit/branch switch elsewhere. */
  const blocked = busy || !!gitActive
  /** The UI only surfaces facts it can read from the repository state and never
   *  pre-judges whether an operation is legal — same contract as the Actions
   *  menu, where the backend owns that decision. The worktree is therefore not a
   *  gate: git allows a merge with local changes when paths do not overlap, and
   *  the backend refuses with its own message when they do. */
  const syncDisabledReason = !hasRemote ? 'Add a remote in Git settings to sync.' : !targetBranch ? 'No branch checked out.' : ''
  /** A fresh repository has no commits, so `behind` cannot describe what Merge
   *  would bring in — it adopts the remote branch instead. Rebasing is what
   *  needs local history, so only Rebase keys off `hasCommits`. */
  const unmatchedBehind = !hasCommits ? true : behind > 0
  const incoming = unmatchedBehind && !inProgress && !!activeRemote && !!targetBranch
  /** Disabled reasons state the observable fact, not a verdict: `behind` is
   *  known locally, while the backend still decides if the operation can run. */
  const rebaseDisabledReason = !incoming || !hasCommits ? 'Nothing to rebase — remote has no new commits.' : ''
  const mergeDisabledReason = !incoming ? 'Nothing to merge — remote has no new commits.' : ''
  const locked = !!syncDisabledReason || blocked
  const actionHint = (reason: string, title: string) => (!busy && reason ? reason : title)

  useEffect(() => {
    if (syncState !== 'done') return
    const timer = setTimeout(() => setSyncState('idle'), 3000)
    return () => clearTimeout(timer)
  }, [syncState])

  const run = async (label: string, action: () => Promise<boolean | void>) => {
    if (blocked) return
    setActiveAction(label); setSyncState('busy'); setErr(''); setNotice('')
    try {
      const success = await withGitOperation(label, action)
      setSyncState(success === false ? 'idle' : 'done')
      setActivePopover(null)
    } catch (e) {
      setErr(String(e))
      setSyncState('error')
    }
  }

  const afterSync = async () => {
    await pollGitStatus()
    await useVaultStore.getState().loadTree().catch(() => {})
  }

  const report = (outcome: SyncOutcome) => {
    if (outcome.conflicts.length > 0) {
      setNotice(`${outcome.message}: ${outcome.conflicts.join(', ')}`)
      return false
    }
    if (!outcome.success || outcome.error) throw new Error(outcome.error || outcome.message)
    setNotice(outcome.message)
    return true
  }

  const pullRemote = () => run('pull', async () => {
    try {
      const outcome: PullOutcome = JSON.parse(await invoke<string>('git_pull', {
        request: { remote: activeRemote, branch: targetBranch, strategy: 'auto' },
      }))
      const success = report(outcome)
      if (success && outcome.remoteChanged) setNotice(`${outcome.message} · ${outcome.remote} changed during fetch`)
      return success
    } finally {
      await afterSync()
    }
  })

  const fetchRemote = () => run('fetch', async () => {
    await invoke('git_fetch', { name: activeRemote })
    setNotice(`Fetched ${activeRemote}`)
    await pollGitStatus()
  })

  // Each sync refreshes in `finally`: a failed step can still leave a merge or
  // rebase on disk, and the panel must offer Continue/Abort for it.
  const mergeRemote = () => run('merge', async () => {
    try {
      await invoke('git_fetch', { name: activeRemote })
      return report(JSON.parse(await invoke<string>('git_remote_merge', { name: activeRemote, branch: targetBranch })))
    } finally {
      await afterSync()
    }
  })

  const rebaseRemote = () => run('rebase', async () => {
    try {
      await invoke('git_fetch', { name: activeRemote })
      return report(JSON.parse(await invoke<string>('git_rebase', { name: activeRemote, branch: targetBranch })))
    } finally {
      await afterSync()
    }
  })

  const continueRebase = () => run('continue', async () => {
    try {
      return report(JSON.parse(await invoke<string>('git_rebase_continue')))
    } finally {
      await afterSync()
    }
  })

  const abort = () => run('abort', async () => {
    const which = confirmAbort
    setConfirmAbort(null)
    try {
      await invoke(which === 'merge' ? 'git_merge_abort' : 'git_rebase_abort')
      setNotice(which === 'merge' ? 'Merge aborted' : 'Rebase aborted')
    } finally {
      await afterSync()
    }
  })

  const btn = 'flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[12px] cursor-pointer border-none bg-transparent text-foreground-secondary hover:bg-surface-active hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed'
  const operationBtn = 'rounded px-2 py-1 text-[11px] cursor-pointer border-none bg-surface-hover text-foreground-secondary hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap'
  const idle = !inProgress && !!activeRemote && hasRemote
  const showHints = syncOpen
  const actionLabel = (action: 'pull' | 'fetch' | 'rebase' | 'merge', idleLabel: string, busyLabel: string, doneLabel: string) =>
    busy && activeAction === action ? busyLabel :
      syncState === 'done' && activeAction === action ? doneLabel :
        syncState === 'error' && activeAction === action ? `${idleLabel} failed` : idleLabel
  const actionClass = (action: 'pull' | 'fetch' | 'rebase' | 'merge') =>
    busy && activeAction === action ? 'text-accent' :
      syncState === 'done' && activeAction === action ? 'text-success' :
        syncState === 'error' && activeAction === action ? 'text-danger' : 'text-foreground-secondary'
  /** Keep the pre-existing escape hatch even though Cancel holds focus by
   *  default: a modal that cannot be dismissed from the keyboard is a trap. */
  const cancelAbort = () => {
    setConfirmAbort(null)
    abortRef.current?.focus()
  }

  return (
    <div ref={syncRef} className="relative border-b border-border-subtle px-3 py-2 text-[11px]">
      <div className="flex items-center gap-2">
        <BranchSwitcher branch={branch} open={activePopover === 'branch'} onToggle={() => setActivePopover(activePopover === 'branch' ? null : 'branch')} />
        {ahead > 0 && <span className="text-[10px] text-muted">↑{ahead}</span>}
        {behind > 0 && <span className="text-[10px] text-muted">↓{behind}</span>}
        {rebasing || merging ? (
          <div className="flex items-center gap-1.5">
          {rebasing && <button type="button" className={operationBtn} onClick={continueRebase} disabled={blocked}>Continue</button>}
          <button type="button" className={operationBtn} onClick={() => setConfirmAbort(rebasing ? 'rebase' : 'merge')} disabled={blocked}>Abort</button>
          </div>
        ) : (
          <span className="relative">
            <button
              type="button"
              aria-label="Git sync actions"
              aria-expanded={syncOpen}
              onClick={() => setActivePopover(activePopover === 'actions' ? null : 'actions')}
              disabled={!idle || blocked}
              title={activeRemote && targetBranch ? `Sync ${localBranch} with ${activeRemote}` : 'Sync current branch'}
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] cursor-pointer border-none bg-surface-hover text-foreground-secondary hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy && activeAction === 'pull' ? 'Pulling…' : busy && activeAction === 'fetch' ? 'Fetching…' : busy && activeAction === 'rebase' ? 'Rebasing…' : busy && activeAction === 'merge' ? 'Merging…' : syncState === 'error' ? 'Sync failed' : syncState === 'done' ? `${activeAction} done` : 'Actions'}
              <ChevronDown size={11} className={'transition-transform ' + (syncOpen ? 'rotate-180' : '')} />
            </button>
          </span>
        )}
        {syncOpen && (
          <SidebarPopover side="bottom">
            {remotes.length > 1 && (
              <label className="block border-b border-border-subtle px-2 py-1.5 text-[10px] text-muted">
                Remote
                <select
                  aria-label="Sync remote"
                  value={activeRemote}
                  onChange={e => setSelected(e.target.value)}
                  disabled={busy}
                  className="mt-1 w-full rounded border border-border-subtle bg-background px-1 py-1 text-[11px] font-mono text-foreground outline-none"
                >
                  {remotes.map(name => <option key={name} value={name}>{name}</option>)}
                </select>
              </label>
            )}
            <button type="button" className={btn} onClick={fetchRemote} disabled={locked} title={locked && syncDisabledReason ? syncDisabledReason : `Fetch ${activeRemote}`}>
              <RefreshCw size={12} className={actionClass('fetch')} /> {actionLabel('fetch', 'Fetch', 'Fetching…', 'Fetched')}
            </button>
            <button type="button" className={btn} onClick={pullRemote} disabled={locked} title={locked && syncDisabledReason ? syncDisabledReason : `Pull ${activeRemote}/${targetBranch} with automatic rebase or merge`}>
              <GitPullRequest size={12} className={actionClass('pull')} /> {actionLabel('pull', 'Pull', 'Pulling…', 'Pulled')}
            </button>
            <button
              type="button"
              className={btn}
              onClick={rebaseRemote}
              disabled={locked || !incoming || !hasCommits}
              title={hasCommits ? actionHint(rebaseDisabledReason, `Rebase ${localBranch} onto ${activeRemote}/${targetBranch}`) : 'No local commits yet — Merge brings in the remote branch instead'}
            >
              <GitBranch size={12} className={actionClass('rebase')} /> {actionLabel('rebase', 'Rebase', 'Rebasing…', 'Rebased')}
              {showHints && !busy && incoming && <span className="ml-auto text-[10px] text-muted">↓{behind}</span>}
            </button>
            <button type="button" className={btn} onClick={mergeRemote} disabled={locked || !!mergeDisabledReason} title={actionHint(mergeDisabledReason, `Merge ${activeRemote}/${targetBranch} into ${localBranch}`)}>
              <GitMerge size={12} className={actionClass('merge')} /> {actionLabel('merge', 'Merge', 'Merging…', 'Merged')}
              {showHints && !busy && incoming && <span className="ml-auto text-[10px] text-muted">↓{behind}</span>}
            </button>
            {showHints && !busy && mergeDisabledReason && <div className="px-2.5 pb-1 text-[10px] text-muted">{mergeDisabledReason}</div>}
            {showHints && !busy && !mergeDisabledReason && rebaseDisabledReason && <div className="px-2.5 pb-1 text-[10px] text-muted">{rebaseDisabledReason}</div>}
            {remotes.length > 1 && <div className="border-t border-border-subtle px-2 py-1.5 text-[10px] text-muted">Push still follows branch upstream.</div>}
          </SidebarPopover>
        )}
      </div>

      {merging && (
        <div className="mt-1.5 text-[10px] text-warning">Merge in progress — resolve the conflicted files below, stage them, then commit below.</div>
      )}
      {rebasing && (
        <div className="mt-1.5 text-[10px] text-warning">Rebase in progress — resolve the conflicted files below, stage them, then Continue.</div>
      )}
      {foreignState && (
        <div className="mt-1.5 text-[10px] text-warning">
          A {repoState} is in progress — finish or abort it with system Git. Fetch, Rebase, and Merge stay disabled until the repository is clean again.
        </div>
      )}
      {!hasRemote && <div className="mt-1.5 text-[10px] text-muted">Add a remote in Git settings to sync.</div>}
      {notice && <div className="mt-1.5 text-[10px] text-foreground-secondary">{notice}</div>}
      {err && <div className="mt-1.5 text-[10px] text-danger">{err}</div>}

      {confirmAbort && (
        <OverlayPortal>
          <div role="alertdialog" aria-modal="true" aria-label="Abort in-progress operation" tabIndex={-1} ref={abortRef} className="fixed inset-0 z-220 flex items-center justify-center ui-backdrop outline-none" onClick={cancelAbort} onKeyDown={e => { if (e.key === 'Escape') cancelAbort() }}>
            <div className="ui-popover p-4 w-80" onClick={e => e.stopPropagation()}>
              <div className="text-sm font-semibold mb-1">Abort the {confirmAbort}?</div>
              <div className="text-xs text-foreground-secondary mb-4">Every uncommitted change made during the {confirmAbort} is discarded — resolved and unresolved files alike, staged or not — and the branch returns to its previous state.</div>
              <div className="flex justify-end gap-2">
                <button autoFocus onClick={cancelAbort} className="text-xs px-3 py-1.5 rounded border border-border-subtle bg-transparent text-foreground-secondary cursor-pointer hover:bg-surface-active">Cancel</button>
                <button onClick={() => void abort()} className="text-xs px-3 py-1.5 rounded bg-danger text-on-danger cursor-pointer border-none">Abort</button>
              </div>
            </div>
          </div>
        </OverlayPortal>
      )}
    </div>
  )
}

/** Commit and push live with repository changes. Manual text always wins; the
 *  sparkle explicitly asks the configured Rust-backed AI flow to fill it. */
function GitActions() {
  const { isRepo, hasRemote, ahead, upstream, status, repoState = 'clean' } = useGitStatus()
  const tabs = useEditorStore(state => state.tabs)
  const activeTab = useEditorStore(state => state.activeTab)
  const [message, setMessage] = useState('')
  const [commitState, setCommitState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [pushState, setPushState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const gitActive = useGitOperation(state => state.active)
  const [generating, setGenerating] = useState(false)
  const [commitNotice, setCommitNotice] = useState('')
  const [pushNotice, setPushNotice] = useState('')

  const hasUnsaved = tabs.some(tab => tab.dirty)
  const merging = repoState === 'merge'
  const committableState = repoState === 'clean' || merging
  const hasChanges = status.trim().length > 0
  /** Commit stages everything first; with conflicts still listed that would
   *  record conflict markers, so each file must be resolved and staged first. */
  const hasConflicts = useMemo(() => parseStatus(status).some(conflictOf), [status])
  const busy = commitState === 'busy' || pushState === 'busy' || !!gitActive
  const commitDisabled = !isRepo || hasUnsaved || !committableState || hasConflicts || (!hasChanges && !merging) || !message.trim() || busy || generating
  const pushDisabled = !isRepo || !hasRemote || (!!upstream && ahead <= 0) || busy

  useEffect(() => {
    if (commitState !== 'done' && pushState !== 'done') return
    const timer = setTimeout(() => {
      setCommitState(state => state === 'done' ? 'idle' : state)
      setPushState(state => state === 'done' ? 'idle' : state)
    }, 3000)
    return () => clearTimeout(timer)
  }, [commitState, pushState])

  const generateMessage = async () => {
    if (generating || !isRepo) return
    setGenerating(true)
    setCommitNotice('')
    try {
      let freshStatus = status
      try { freshStatus = JSON.parse(await invoke<string>('git_status')).status || status } catch { /* current poll is enough */ }
      const fallbackName = tabs.find(tab => tab.path === activeTab)?.name
      // Lazy: a single-file change set is named without ever fetching the diff.
      const generated = await autoCommitMessage(freshStatus, fallbackName, () => invoke<string>('git_diff_summary'))
      // Manual text always wins: keep anything typed while the AI was working.
      setMessage(typed => typed === message ? generated : typed)
    } finally {
      setGenerating(false)
    }
  }

  const commit = async () => {
    const commitMessage = message.trim()
    if (commitDisabled || !commitMessage) return
    setCommitState('busy')
    setCommitNotice('')
    try {
      await withGitOperation('commit', async () => {
        await invoke('git_stage')
        const result = JSON.parse(await invoke<string>('git_commit', { message: commitMessage }))
        if (result.error) { setCommitNotice(result.error); setCommitState('error'); return }
        if (result.message === 'Nothing to commit') { setCommitState('idle'); toast.info('Nothing to commit'); return }
        setMessage('')
        setCommitNotice(result.commit ? `Committed ${result.commit.substring(0, 7)}` : 'Committed')
        setCommitState('done')
      })
    } catch (error) {
      setCommitNotice(String(error))
      setCommitState('error')
    } finally {
      await pollGitStatus()
    }
  }

  const push = async () => {
    if (pushDisabled) return
    setPushState('busy')
    setPushNotice('')
    try {
      await withGitOperation('push', async () => {
        const result = JSON.parse(await invoke<string>('git_push_only'))
        if (result.error) { setPushNotice(result.error); setPushState('error'); return }
        if (result.message === 'Nothing to push') { setPushState('idle'); toast.info('Nothing to push'); return }
        setPushNotice('Pushed ✓')
        setPushState('done')
      })
    } catch (error) {
      setPushNotice(String(error))
      setPushState('error')
    } finally {
      await pollGitStatus()
    }
  }

  return (
    <div className="shrink-0 border-t border-border-subtle p-2">
      <div className="relative rounded-md border border-border bg-background focus-within:border-accent">
        <textarea
          value={message}
          onChange={event => setMessage(event.target.value)}
          placeholder="Enter commit message"
          aria-label="Commit message"
          rows={4}
          className="block min-h-24 w-full resize-none bg-transparent px-2.5 pt-2 pb-10 text-[12px] leading-relaxed text-foreground outline-none placeholder:text-muted"
        />
        <div className="absolute inset-x-1.5 bottom-1.5 flex items-center justify-between gap-1">
          <button
            type="button"
            onClick={() => void generateMessage()}
            disabled={!isRepo || (!hasChanges && !merging) || generating || busy}
            aria-label="Generate commit message with AI"
            title="Generate commit message with AI"
            className="flex size-7 items-center justify-center rounded border-none bg-transparent text-foreground-subtle cursor-pointer hover:bg-surface-active hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <PencilSparkles size={14} className={generating ? 'animate-pulse' : ''} />
          </button>
          <div className="flex items-center gap-1">
            <button
              type="button"
              data-testid="git-push"
              onClick={() => void push()}
              disabled={pushDisabled}
              className="flex h-7 items-center gap-1 rounded border border-border-subtle bg-transparent px-2 text-[11px] text-foreground-secondary cursor-pointer hover:bg-surface-active hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Upload size={12} />
              {pushState === 'busy' ? 'Pushing…' : pushState === 'done' ? 'Pushed' : pushState === 'error' ? 'Retry Push' : 'Push'}
              {upstream && ahead > 0 && <span className="text-[10px] text-muted">↑{ahead}</span>}
            </button>
            <button
              type="button"
              data-testid="git-commit"
              onClick={() => void commit()}
              disabled={commitDisabled}
              className="flex h-7 items-center gap-1 rounded border border-border-subtle bg-surface-hover px-2 text-[11px] text-foreground-secondary cursor-pointer hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <GitCommitHorizontal size={12} />
              {commitState === 'busy' ? 'Committing…' : commitState === 'done' ? 'Committed' : 'Commit'}
            </button>
          </div>
        </div>
      </div>
      {hasUnsaved && isRepo && <div className="mt-1.5 text-[10px] text-muted">Unsaved editor changes — wait for autosave or switch mode before committing.</div>}
      {!hasChanges && merging && !hasUnsaved && <div className="mt-1.5 text-[10px] text-muted">Merge in progress — commit records the resolved working tree.</div>}
      {commitNotice && <div className={'mt-1.5 wrap-break-word text-[10px] ' + (commitState === 'error' ? 'text-danger' : 'text-success')}>{commitNotice}</div>}
      {pushNotice && <div className={'mt-1.5 wrap-break-word text-[10px] ' + (pushState === 'error' ? 'text-danger' : 'text-success')}>{pushNotice}</div>}
    </div>
  )
}

export default function GitPanel() {
  const { isRepo, branch, status, ahead, behind, error: statusError = '' } = useGitStatus()
  const [staging, setStaging] = useState('')
  const [stageError, setStageError] = useState('')
  const gitActive = useGitOperation(state => state.active)
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
    try { await withGitOperation('stage', () => invoke('git_stage', { path })) }
    catch (error) { setStageError(String(error)) }
    finally {
      setStaging('')
      await pollGitStatus()
    }
  }

  return (
    <section aria-label="Git Panel" className="flex min-h-0 flex-1 flex-col text-xs">
      {isRepo ? <SyncBar /> : (
        <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
          <GitBranch size={13} className="shrink-0 text-foreground-subtle" />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground-secondary">{branch || 'no branch'}</span>
          {ahead > 0 && <span className="text-[10px] text-muted">↑{ahead}</span>}
          {behind > 0 && <span className="text-[10px] text-muted">↓{behind}</span>}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!isRepo && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-foreground-subtle">
            <GitMerge size={20} />
            <span>Vault is not a git repository.</span>
          </div>
        )}
        {isRepo && statusError && (
          <div role="alert" className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-danger">
            <AlertTriangle size={20} />
            <span>Cannot read repository status.</span>
            <span className="text-[10px] wrap-break-word text-foreground-subtle">{statusError}</span>
          </div>
        )}
        {isRepo && !statusError && entries.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-foreground-subtle">
            <Check size={20} className="text-success" />
            <span>Working tree is clean.</span>
          </div>
        )}
        {isRepo && conflicts.length > 0 && (
          <section className="mb-3">
            <div className="mb-1 px-1 text-[10px] uppercase tracking-wider text-danger">Conflicts ({conflicts.length})</div>
            {conflicts.map(entry => (
              <ConflictRow key={`conflict:${entry.path}`} entry={entry} onStage={stageConflict} disabled={staging === entry.path || !!gitActive} />
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
      <GitActions />
    </section>
  )
}
