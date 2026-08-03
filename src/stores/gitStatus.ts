import { create } from 'zustand'
import { useEffect } from 'react'

/** Shared git status (branch + porcelain status) polled ONCE and consumed by
 *  StatusBar + TabBar (PERF-1: previously two parallel pollers ran 3s + 5s). */
interface GitStatusState {
  branch: string
  status: string
}

export const useGitStatus = create<GitStatusState>(() => ({ branch: '', status: '' }))

async function pollGitStatus() {
  try {
    const m = await import('@tauri-apps/api/core')
    const s = await m.invoke<string>('git_status')
    const d = JSON.parse(s)
    useGitStatus.setState({ branch: d.branch || '', status: d.status || '' })
  } catch {
    useGitStatus.setState({ branch: '', status: '' })
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
