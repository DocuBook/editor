
import { useState, useEffect } from 'react'
import './index.css'
import Sidebar from './components/Sidebar'
import Editor from './components/Editor'
import StatusBar from './components/StatusBar'
import { Toaster } from 'sonner'
import { PanelLeftOpen, Command } from 'lucide-react'

import { useGitPolling } from './stores/gitStatus'
import { useEditorStore } from './stores/editor'
import { listen, invoke } from './lib/ipc'
import { useAuth, initAuthGuard } from './stores/auth'
import SetupWizard from './components/SetupWizard'
import Login from './components/Login'

initAuthGuard()

/** Root application component with keyboard shortcuts. */
export default function App() {
  const { status } = useAuth()
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const toggleSidebar = () => setSidebarOpen(o => !o)
  useEffect(() => { useAuth.getState().init() }, [])

  /** Single git-status poller shared by StatusBar + TabBar. */
  useGitPolling()

  /** Graceful shutdown: on window close, flush + save all dirty tabs, then confirm. */
  useEffect(() => {
    let unsub: (() => void) | undefined
    let cancelled = false
    listen('app:before-close', async () => {
      await useEditorStore.getState().persistAllDirty()
      if (!cancelled) {
        try { await invoke('app_ready_to_close') } catch (e) { console.error('close:', e) }
      }
    }).then(u => { if (!cancelled) unsub = u })
    return () => { cancelled = true; unsub?.() }
  }, [])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') { e.preventDefault(); setSidebarOpen(o => !o) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

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
        {sidebarOpen ? (
          <Sidebar onToggleSidebar={toggleSidebar} />
        ) : (
          <div className="shrink-0 flex flex-col items-center border-r border-border-subtle w-[34px] pt-1.5">
            <span className="tip-wrap tip-strip">
              <button onClick={toggleSidebar} aria-label="Expand sidebar" className="hover:bg-surface-active hover:text-foreground-secondary transition-colors p-1.5 cursor-pointer bg-transparent border-none rounded-md flex text-foreground-subtle">
                <PanelLeftOpen size={16} />
              </button>
              <span className="tip">Expand sidebar <kbd><Command size={11} />J</kbd></span>
            </span>
          </div>
        )}
        <main className="flex-1 flex flex-col min-w-0 min-h-0"><Editor /></main>
      </div>
      <StatusBar />
      <Toaster position="bottom-right" theme="dark" richColors />
    </div>
  )
}
