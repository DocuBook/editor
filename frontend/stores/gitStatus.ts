import { create } from 'zustand'
import { useEffect } from 'react'
import { useAuth } from './auth'
import { invoke } from '../lib/ipc'

/** Shared git status (branch + porcelain status) polled ONCE and consumed by
 *  TabBar (PERF-1: previously two parallel pollers ran 3s + 5s). */
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

export async function pollGitStatus() {
  // Skip while unauthenticated (web login/setup screen): the server answers 401
  // for every poll, spamming the console — the poll only matters once a vault
  // session exists. Desktop always reports 'ready', so it is unaffected.
  if (useAuth.getState().status !== 'ready') return
  try {
    const s = await invoke<string>('git_status')
    const d = JSON.parse(s)
    useGitStatus.setState({ isRepo: d.isRepo === true, hasRemote: d.hasRemote === true, branch: d.branch || '', upstream: d.upstream || '', status: d.status || '', ahead: d.ahead ?? 0, behind: d.behind ?? 0, pushTarget: d.pushTarget || '', hasCommits: d.hasCommits === true, remotes: Array.isArray(d.remotes) ? d.remotes : [], repoState: d.state || 'clean' })
  } catch {
    useGitStatus.setState(EMPTY_GIT_STATUS)
  }
}

/** Single polling loop (3s), started once at the app root. */
export function useGitPolling() {
  useEffect(() => {
    pollGitStatus()
    const id = setInterval(pollGitStatus, 3000)
    return () => clearInterval(id)
  }, [])
}
