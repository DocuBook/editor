import { create } from 'zustand'
import { useEffect } from 'react'
import { useAuth } from './auth'

/** Shared git status (branch + porcelain status) polled ONCE and consumed by
 *  StatusBar + TabBar (PERF-1: previously two parallel pollers ran 3s + 5s). */
interface GitStatusState {
  isRepo: boolean
  hasRemote: boolean
  branch: string
  status: string
}

const EMPTY_GIT_STATUS: GitStatusState = { isRepo: false, hasRemote: false, branch: '', status: '' }

export const useGitStatus = create<GitStatusState>(() => EMPTY_GIT_STATUS)

export async function pollGitStatus() {
  // Skip while unauthenticated (web login/setup screen): the server answers 401
  // for every poll, spamming the console — the poll only matters once a vault
  // session exists. Desktop always reports 'ready', so it is unaffected.
  if (useAuth.getState().status !== 'ready') return
  try {
    const { invoke } = await import('../lib/ipc')
    const s = await invoke<string>('git_status')
    const d = JSON.parse(s)
    useGitStatus.setState({ isRepo: d.isRepo === true, hasRemote: d.hasRemote === true, branch: d.branch || '', status: d.status || '' })
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
