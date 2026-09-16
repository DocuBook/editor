import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, File, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest, PencilSparkles, RefreshCw, Upload } from 'lucide-react'
import { invoke } from '../../lib/ipc'
import { useGitStatus, pollGitStatus } from '../../stores/gitStatus'
import { useEditorStore } from '../../stores/editor'
import { useVaultStore } from '../../stores/vault'
import { useClickOutside } from '../../hooks/useClickOutside'
import SidebarPopover from '../SidebarPopover'
import { autoCommitMessage } from '../../utils/commitMessage'
import { toast } from 'sonner'

interface GitEntry {
  x: string
  y: string
  path: string
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
  const { branch, ahead = 0, behind = 0, hasRemote, hasCommits, pushTarget = '', remotes = [], repoState = 'clean' } = useGitStatus()
  const [selected, setSelected] = useState('')
  const [syncOpen, setSyncOpen] = useState(false)
  const [syncState, setSyncState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [activeAction, setActiveAction] = useState('')
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmAbort, setConfirmAbort] = useState<'merge' | 'rebase' | null>(null)
  const syncRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<HTMLDivElement>(null)
  useClickOutside(syncRef, () => setSyncOpen(false))

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
  /** Sidebar branch picker and this panel consume the same store field. Never
   *  derive a second branch from an upstream label such as `origin/master`. */
  const targetBranch = branch && !branch.startsWith('(') ? branch : ''
  const busy = syncState === 'busy'
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
  const locked = !!syncDisabledReason || busy
  const actionHint = (reason: string, title: string) => (!busy && reason ? reason : title)

  useEffect(() => {
    if (syncState !== 'done') return
    const timer = setTimeout(() => setSyncState('idle'), 3000)
    return () => clearTimeout(timer)
  }, [syncState])

  const run = async (label: string, action: () => Promise<boolean | void>) => {
    if (busy) return
    setActiveAction(label); setSyncState('busy'); setErr(''); setNotice('')
    try {
      const success = await action()
      setSyncState(success === false ? 'idle' : 'done')
      setSyncOpen(false)
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

  const mergeRemote = () => run('merge', async () => {
    await invoke('git_fetch', { name: activeRemote })
    const success = report(JSON.parse(await invoke<string>('git_remote_merge', { name: activeRemote, branch: targetBranch })))
    await afterSync()
    return success
  })

  const rebaseRemote = () => run('rebase', async () => {
    await invoke('git_fetch', { name: activeRemote })
    const success = report(JSON.parse(await invoke<string>('git_rebase', { name: activeRemote, branch: targetBranch })))
    await afterSync()
    return success
  })

  const continueRebase = () => run('continue', async () => {
    const success = report(JSON.parse(await invoke<string>('git_rebase_continue')))
    await afterSync()
    return success
  })

  const abort = () => run('abort', async () => {
    const which = confirmAbort
    setConfirmAbort(null)
    await invoke(which === 'merge' ? 'git_merge_abort' : 'git_rebase_abort')
    setNotice(which === 'merge' ? 'Merge aborted' : 'Rebase aborted')
    await afterSync()
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
        <GitBranch size={13} className="shrink-0 text-foreground-subtle" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground-secondary">{branch || 'no branch'}</span>
        {ahead > 0 && <span className="text-[10px] text-muted">↑{ahead}</span>}
        {behind > 0 && <span className="text-[10px] text-muted">↓{behind}</span>}
        {rebasing || merging ? (
          <div className="flex items-center gap-1.5">
          {rebasing && <button type="button" className={operationBtn} onClick={continueRebase} disabled={busy}>Continue</button>}
          <button type="button" className={operationBtn} onClick={() => setConfirmAbort(rebasing ? 'rebase' : 'merge')} disabled={busy}>Abort</button>
          </div>
        ) : (
          <span className="relative">
            <button
              type="button"
              aria-label="Git sync actions"
              aria-expanded={syncOpen}
              onClick={() => setSyncOpen(open => !open)}
              disabled={!idle || busy}
              title={activeRemote && targetBranch ? `Sync ${targetBranch} with ${activeRemote}` : 'Sync current branch'}
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
              title={hasCommits ? actionHint(rebaseDisabledReason, `Rebase ${targetBranch} onto ${activeRemote}/${targetBranch}`) : 'No local commits yet — Merge brings in the remote branch instead'}
            >
              <GitBranch size={12} className={actionClass('rebase')} /> {actionLabel('rebase', 'Rebase', 'Rebasing…', 'Rebased')}
              {showHints && !busy && incoming && <span className="ml-auto text-[10px] text-muted">↓{behind}</span>}
            </button>
            <button type="button" className={btn} onClick={mergeRemote} disabled={locked || !!mergeDisabledReason} title={actionHint(mergeDisabledReason, `Merge ${activeRemote}/${targetBranch} into ${targetBranch}`)}>
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

/** Commit and push live with repository changes. Manual text always wins; the
 *  sparkle explicitly asks the configured Rust-backed AI flow to fill it. */
function GitActions() {
  const { isRepo, hasRemote, ahead, upstream, status, repoState = 'clean' } = useGitStatus()
  const tabs = useEditorStore(state => state.tabs)
  const activeTab = useEditorStore(state => state.activeTab)
  const [message, setMessage] = useState('')
  const [commitState, setCommitState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [pushState, setPushState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [generating, setGenerating] = useState(false)
  const [commitNotice, setCommitNotice] = useState('')
  const [pushNotice, setPushNotice] = useState('')

  const hasUnsaved = tabs.some(tab => tab.dirty)
  const merging = repoState === 'merge'
  const committableState = repoState === 'clean' || merging
  const hasChanges = status.trim().length > 0
  const busy = commitState === 'busy' || pushState === 'busy'
  const commitDisabled = !isRepo || hasUnsaved || !committableState || (!hasChanges && !merging) || !message.trim() || busy || generating
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
      let diffSummary = ''
      try { diffSummary = await invoke<string>('git_diff_summary') } catch { /* status still supports the fallback */ }
      const fallbackName = tabs.find(tab => tab.path === activeTab)?.name
      setMessage(await autoCommitMessage(freshStatus, fallbackName, diffSummary))
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
      await invoke('git_stage')
      const result = JSON.parse(await invoke<string>('git_commit', { message: commitMessage }))
      if (result.error) { setCommitNotice(result.error); setCommitState('error'); return }
      if (result.message === 'Nothing to commit') { setCommitState('idle'); toast.info('Nothing to commit'); return }
      setMessage('')
      setCommitNotice(result.commit ? `Committed ${result.commit.substring(0, 7)}` : 'Committed')
      setCommitState('done')
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
      const result = JSON.parse(await invoke<string>('git_push_only'))
      if (result.error) { setPushNotice(result.error); setPushState('error'); return }
      if (result.message === 'Nothing to push') { setPushState('idle'); toast.info('Nothing to push'); return }
      setPushNotice('Pushed ✓')
      setPushState('done')
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
      {isRepo && <SyncBar />}
      {!isRepo && (
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
      <GitActions />
    </section>
  )
}
