import { create } from 'zustand'
import { useEffect } from 'react'
import { useAuth } from './auth'
import { useVaultStore } from './vault'
import { invoke } from '../lib/ipc'

/** Shared git status (branch + porcelain status) refreshed on events and consumed
 *  by TabBar, SyncStatusBadge, SidebarFooter and GitPanel. No timer: the previous
 *  3s poller fired a request every three seconds even for vaults that are not
 *  repositories (PERF-1) — status now refreshes on git actions, vault open/close,
 *  and window/tab focus, and only while a git repo is actually present. */
interface GitStatusState {
  isRepo: boolean
  hasRemote: boolean
  branch: string
  /** Tracking ref of the current branch (`origin/main`); empty = never pushed. */
  upstream: string
  /** Porcelain v1-style status lines (`XY path`) — parsed per-tab by TabBar. */
  status: string
  /** Local commits not yet on the upstream branch (drives Push gating). */
  ahead: number
  behind: number
  /** Remote `git push` resolves to for the current branch; empty without remotes. */
  pushTarget: string
  /** False on a fresh repository — no commit exists yet to push. */
  hasCommits: boolean
  /** Configured remote names, in config order — more than one is supported. */
  remotes: string[]
  /** In-progress git operation (`clean`, `merge`, `rebase`, …): the UI offers
   *  Continue/Abort instead of starting a new sync. */
  repoState: string
}

const EMPTY_GIT_STATUS: GitStatusState = { isRepo: false, hasRemote: false, branch: '', upstream: '', status: '', ahead: 0, behind: 0, pushTarget: '', hasCommits: false, remotes: [], repoState: 'clean' }

export const useGitStatus = create<GitStatusState>(() => EMPTY_GIT_STATUS)

/** True once this session learned whether the vault is a git repository. A known
 *  non-repo is not re-probed by plain events (there is nothing to refresh); only
 *  a forced call re-checks it — vault open, window focus, or `git init`. */
let probed = false

export async function pollGitStatus(force = false) {
  // Skip while unauthenticated (web login/setup screen): the server answers 401
  // for every poll, spamming the console — the poll only matters once a vault
  // session exists. Desktop always reports 'ready', so it is unaffected.
  if (useAuth.getState().status !== 'ready') return
  // No vault, no working tree to inspect.
  if (!useVaultStore.getState().isOpen) return
  // A vault without a .git has nothing to refresh: once its repo-ness is known,
  // only forced events re-probe it instead of polling it every few seconds.
  if (!force && probed && !useGitStatus.getState().isRepo) return
  probed = true
  try {
    const s = await invoke<string>('git_status')
    const d = JSON.parse(s)
    useGitStatus.setState({ isRepo: d.isRepo === true, hasRemote: d.hasRemote === true, branch: d.branch || '', upstream: d.upstream || '', status: d.status || '', ahead: d.ahead ?? 0, behind: d.behind ?? 0, pushTarget: d.pushTarget || '', hasCommits: d.hasCommits === true, remotes: Array.isArray(d.remotes) ? d.remotes : [], repoState: d.state || 'clean' })
  } catch {
    // Transient backend failure — let the next event probe again instead of
    // leaving the store permanently empty.
    probed = false
    useGitStatus.setState(EMPTY_GIT_STATUS)
  }
}

/** Event-driven git-status refresh, attached once at the app root: on mount, on
 *  vault open/close, and when the window/tab regains focus (files may have
 *  changed while the app was in the background). No interval. */
export function useGitStatusRefresh() {
  useEffect(() => {
    void pollGitStatus(true)
    const refresh = () => void pollGitStatus(true)
    const onVisibility = () => { if (document.visibilityState === 'visible') refresh() }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisibility)
    const unsub = useVaultStore.subscribe((state, prev) => {
      if (state.isOpen === prev.isOpen) return
      if (state.isOpen) {
        void pollGitStatus(true)
      } else {
        // Forget repo-ness and clear stale branch/status from the previous vault.
        probed = false
        useGitStatus.setState(EMPTY_GIT_STATUS)
      }
    })
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisibility)
      unsub()
    }
  }, [])
}
