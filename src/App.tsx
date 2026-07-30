
import { useState, useEffect } from 'react'
import './index.css'
import Sidebar from './components/Sidebar'
import Editor from './components/Editor'
import StatusBar from './components/StatusBar'
import GraphView from './components/GraphView'
import { Toaster } from 'sonner'

/** Root application component with keyboard shortcuts. */
export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [graphOpen, setGraphOpen] = useState(false)

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') { e.preventDefault(); setSidebarOpen(o => !o) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  // Suppress default browser context menu (Reload, Back, etc.)
  // Only in production — dev mode needs right-click for Inspect Element
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
        {sidebarOpen && <Sidebar />}
        <main className="flex-1 flex flex-col min-w-0 min-h-0"><Editor /></main>
      </div>
      <StatusBar />
      {graphOpen && <GraphView onClose={() => setGraphOpen(false)} />}
      <Toaster position="bottom-right" theme="dark" richColors />
    </div>
  )
}
