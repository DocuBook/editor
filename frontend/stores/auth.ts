import { create } from 'zustand'
import { invoke, listen } from '../lib/ipc'

export type AuthStatus = 'checking' | 'setup' | 'login' | 'ready'

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
    try {
      const s = JSON.parse(await invoke<string>('setup_status'))
      if (s.noAuth) { set({ status: 'ready' }); return }
      if (s.setupRequired) { set({ status: 'setup' }); return }
      try {
        const a = JSON.parse(await invoke<string>('account_get'))
        set({ status: 'ready', email: a.email })
      } catch { set({ status: 'login' }) }
    } catch { set({ status: 'ready' }) }
  },

  refresh: async () => {
    // Mirror init(): a successful "Skip — keep open access" flips noAuth,
    // which must land on 'ready' — account_get alone can't tell it apart from
    // "never set up" (no admin exists yet on a fresh install).
    try {
      const s = JSON.parse(await invoke<string>('setup_status'))
      if (s.noAuth) { set({ status: 'ready' }); return }
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
export function initAuthGuard() {
  void listen('auth:unauthorized', () => {
    if (useAuth.getState().status === 'ready') useAuth.getState().refresh()
  })
}
