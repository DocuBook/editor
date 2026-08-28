
import { useState, useEffect } from 'react'
import './index.css'
import Sidebar from './components/Sidebar'
import Editor from './components/Editor'
import StatusBar from './components/StatusBar'
import SettingsModal from './components/SettingsModal'
import { Toaster, toast } from 'sonner'

import { useGitPolling } from './stores/gitStatus'
import { useEditorStore } from './stores/editor'
import { useVaultStore } from './stores/vault'
import { listen, invoke } from './lib/ipc'
import { useAuth, useAuthGuard } from './stores/auth'
import SetupWizard from './components/SetupWizard'
import Login from './components/Login'
import { logger } from './utils/logger'

/** Root application component with keyboard shortcuts. */
export default function App() {
  const { status } = useAuth()
  const isVaultOpen = useVaultStore(s => s.isOpen)
  const openVault = useVaultStore(s => s.openVault)
  /** Default per viewport: closed below the 640px `sm` breakpoint (mobile), open above. */
  const [sidebarOpen, setSidebarOpen] = useState(() => window.matchMedia('(min-width: 640px)').matches)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const toggleSidebar = () => setSidebarOpen(o => !o)
  /** Keep the sidebar closed below 640px: auto-close when shrinking to mobile,
   *  re-open when growing back to desktop. Manual toggle still works anytime. */
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)')
    const onChange = (e: MediaQueryListEvent) => setSidebarOpen(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  useEffect(() => { useAuth.getState().init() }, [])

  /** Single git-status poller shared by StatusBar + TabBar. */
  useGitPolling()
  useAuthGuard()

  /** Graceful shutdown: on window close, flush + save all dirty tabs, then confirm. */
  useEffect(() => {
    let unsub: (() => void) | undefined
    let cancelled = false
    listen('app:before-close', async () => {
      try {
        await useEditorStore.getState().persistAllDirty()
        if (!cancelled) await invoke('app_ready_to_close')
      } catch (error) {
        logger.error('app_close_failed', { error })
        toast.error('App stayed open because changes could not be saved. Check disk access and try closing again.')
      }
    }).then(u => { if (!cancelled) unsub = u })
    return () => { cancelled = true; unsub?.() }
  }, [])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'j' && isVaultOpen) { e.preventDefault(); setSidebarOpen(o => !o) }
      if ((e.metaKey || e.ctrlKey) && e.key === 'o') { e.preventDefault(); openVault() }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); setSettingsOpen(true) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [isVaultOpen, openVault])

  /** Suppress default browser context menu (Reload, Back, etc.) */
  /** Only in production — dev mode needs right-click for Inspect Element */
  useEffect(() => {
    if (import.meta.env.PROD) {
      const h = (e: MouseEvent) => { if (!e.defaultPrevented) e.preventDefault() }
      window.addEventListener('contextmenu', h)
      return () => window.removeEventListener('contextmenu', h)
    }
  }, [])

  /** Auth gate: checking → setup wizard → login → app. Desktop (Tauri) never
   *  gates — this branch only triggers on web when the server enforces login. */
  if (status === 'checking') {
    return <div className="h-screen flex items-center justify-center text-xs text-muted">Loading…</div>
  }
  if (status === 'setup') return <SetupWizard />
  if (status === 'login') return <Login />

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      <div className="flex flex-1 min-h-0">
        {isVaultOpen && sidebarOpen && <Sidebar onOpenSettings={() => setSettingsOpen(true)} />}
        <main className="flex-1 flex flex-col min-w-0 min-h-0"><Editor sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} /></main>
      </div>
      {isVaultOpen && <StatusBar />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      <Toaster position="bottom-right" theme="dark" richColors />
    </div>
  )
}
