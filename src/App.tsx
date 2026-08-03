
import { useState, useEffect } from 'react'
import './index.css'
import Sidebar from './components/Sidebar'
import Editor from './components/Editor'
import StatusBar from './components/StatusBar'
import GraphView from './components/GraphView'
import { Toaster } from 'sonner'
import { PanelLeftOpen, Command } from 'lucide-react'

import { useGitPolling } from './stores/gitStatus'
import { useEditorStore } from './stores/editor'

/** Root application component with keyboard shortcuts. */
export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [graphOpen, setGraphOpen] = useState(false)
  const toggleSidebar = () => setSidebarOpen(o => !o)

  /** Single git-status poller shared by StatusBar + TabBar. */
  useGitPolling()

  /** Graceful shutdown: on window close, flush + save all dirty tabs, then confirm. */
  useEffect(() => {
    let unsub: (() => void) | undefined
    let cancelled = false
    import('@tauri-apps/api/event').then(({ listen }) =>
      listen('app:before-close', async () => {
        await useEditorStore.getState().persistAllDirty()
        if (!cancelled) {
          const { invoke } = await import('@tauri-apps/api/core')
          try { await invoke('app_ready_to_close') } catch (e) { console.error('close:', e) }
        }
      }).then(u => { if (!cancelled) unsub = u })
    )
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

  return (
    <div className="h-screen flex flex-col bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <div className="flex flex-1 min-h-0">
        {sidebarOpen ? (
          <Sidebar onToggleSidebar={toggleSidebar} />
        ) : (
          <div className="shrink-0 flex flex-col items-center border-r border-[var(--border-subtle)] w-[34px] pt-1.5">
            <span className="tip-wrap tip-strip">
              <button onClick={toggleSidebar} aria-label="Expand sidebar" className="hover:bg-[var(--bg-hover)] hover:text-zinc-300 transition-colors p-1.5 cursor-pointer bg-transparent border-none rounded-md flex text-[var(--text-subtle)]">
                <PanelLeftOpen size={16} />
              </button>
              <span className="tip">Expand sidebar <kbd><Command size={11} />J</kbd></span>
            </span>
          </div>
        )}
        <main className="flex-1 flex flex-col min-w-0 min-h-0"><Editor /></main>
      </div>
      <StatusBar />
      {graphOpen && <GraphView onClose={() => setGraphOpen(false)} />}
      <Toaster position="bottom-right" theme="dark" richColors />
    </div>
  )
}
