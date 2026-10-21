import { create } from 'zustand'
import { useEffect } from 'react'
import { invoke, isTauri, listen } from '../lib/ipc'
import { useEditorStore } from './editor'
import { useSyncStore } from './sync'
import { clearEditorCache } from '../utils/editorCache'
import { clearDiagramSVG } from '../utils/mermaidRenderCache'

export type AuthStatus = 'checking' | 'setup' | 'login' | 'ready' | 'error'

/** Drop everything that belongs to the signed-in account.
 *
 *  Persisted stores keep their own copy in localStorage, so clearing only the
 *  in-memory state would leak note contents (the sync queue and conflicts store
 *  full file bodies) to whoever signs in next on the same browser. Both halves
 *  are cleared here, and the sync store's `reset` cancels pending retries so a
 *  drain cannot repopulate the queue after logout.
 *
 *  The vault selection is deliberately left intact: it holds only paths and
 *  folder-expansion flags, never note bodies, and the login screen relies on it
 *  to bring the user back to the vault they were in. */
function clearClientState(): void {
  useSyncStore.getState().reset()
  useSyncStore.persist.clearStorage()
  // closeAllTabs only clears memory — it never saves, so it is safe after the
  // backend session has been revoked.
  useEditorStore.getState().closeAllTabs()
  useEditorStore.persist.clearStorage()
  clearEditorCache()
  clearDiagramSVG()
}

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
    clearClientState()
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
