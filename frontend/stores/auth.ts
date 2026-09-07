import { create } from 'zustand'
import { useEffect } from 'react'
import { invoke, isTauri, listen } from '../lib/ipc'

export type AuthStatus = 'checking' | 'setup' | 'login' | 'ready' | 'error'

interface AuthState {
  status: AuthStatus
  email: string
  init: () => Promise<void>
  refresh: () => Promise<void>
  logout: () => Promise<void>
}

export const useAuth = create<AuthState>((set) => ({
  status: 'checking',
  email: '',

  /** Boot-time gate: setup wizard → login → ready (mirrors server middleware). */
  init: async () => {
    if (isTauri) { set({ status: 'ready' }); return }
    set({ status: 'checking', email: '' })
    try {
      const s = JSON.parse(await invoke<string>('setup_status'))
      if (s.setupRequired) { set({ status: 'setup' }); return }
      try {
        const a = JSON.parse(await invoke<string>('account_get'))
        set({ status: 'ready', email: a.email })
      } catch { set({ status: 'login' }) }
    } catch { set({ status: 'error' }) }
  },

  refresh: async () => {
    try {
      const s = JSON.parse(await invoke<string>('setup_status'))
      if (s.setupRequired) { set({ status: 'setup' }); return }
    } catch { /* ignore — fall through to account_get */ }
    try {
      const a = JSON.parse(await invoke<string>('account_get'))
      set({ status: 'ready', email: a.email })
    } catch {
      // No session — distinguish "never set up" (wizard) from "not logged in".
      try {
        const s = JSON.parse(await invoke<string>('setup_status'))
        set({ status: s.setupRequired ? 'setup' : 'login' })
      } catch { set({ status: 'login' }) }
    }
  },

  logout: async () => {
    try { await invoke('logout') } catch { /* ignore */ }
    set({ status: 'login', email: '' })
  },
}))

/** Any 401 mid-session → back to login (web only; desktop never fires it). */
export function useAuthGuard() {
  useEffect(() => {
    let active = true
    let unlisten: (() => void) | undefined
    void listen('auth:unauthorized', () => {
      if (useAuth.getState().status === 'ready') void useAuth.getState().refresh()
    }).then(stop => {
      if (active) unlisten = stop
      else stop()
    }).catch(error => console.error('[auth] listener setup failed', error))
    return () => {
      active = false
      unlisten?.()
    }
  }, [])
}
