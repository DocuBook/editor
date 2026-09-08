
import { useState, useEffect, useRef, useCallback } from 'react'
import { Drawer } from '@mantine/core'
import { PanelLeftClose } from 'lucide-react'
import Sidebar from './components/Sidebar'
import SearchModal from './components/SearchModal'
import Editor from './components/Editor'
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
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia('(min-width: 640px)').matches)
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true)
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** Search lives here (not in Sidebar) so ⌘F/⌘P and the modal keep working
   *  with the sidebar closed — Sidebar unmounts when hidden. */
  const [searchOpen, setSearchOpen] = useState(false)
  const [confirmCloseVault, setConfirmCloseVault] = useState(false)
  /** Current create-target folder lives in Sidebar; the modal's onSelect only
   *  needs it while the sidebar is mounted, so Sidebar registers its setter. */
  const searchFolderRef = useRef<(path: string) => void>(() => {})
  const sidebarToggleRef = useRef<HTMLButtonElement>(null)
  const registerSearchFolder = useCallback((fn: (path: string) => void) => {
    searchFolderRef.current = fn
    return () => { if (searchFolderRef.current === fn) searchFolderRef.current = () => {} }
  }, [])
  const modalOpen = searchOpen || settingsOpen || confirmCloseVault
  const sidebarOpen = isDesktop ? desktopSidebarOpen : mobileDrawerOpen
  const drawerOpen = !isDesktop && isVaultOpen && status === 'ready' && mobileDrawerOpen && !modalOpen
  const closeMobileDrawer = useCallback(() => setMobileDrawerOpen(false), [])
  const toggleSidebar = useCallback(() => {
    if (!isVaultOpen || status !== 'ready') return
    if (isDesktop) setDesktopSidebarOpen(open => !open)
    else if (!modalOpen) setMobileDrawerOpen(open => !open)
  }, [isDesktop, isVaultOpen, modalOpen, status])
  const openSearch = useCallback(() => {
    setMobileDrawerOpen(false); setSettingsOpen(false); setConfirmCloseVault(false); setSearchOpen(true)
  }, [])
  const openSettings = useCallback(() => {
    setMobileDrawerOpen(false); setSearchOpen(false); setConfirmCloseVault(false); setSettingsOpen(true)
  }, [])
  const requestCloseVault = useCallback(() => {
    setMobileDrawerOpen(false); setSearchOpen(false); setSettingsOpen(false); setConfirmCloseVault(true)
  }, [])

  /** Mobile drawer starts closed on every transition; desktop restores its own collapse preference. */
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)')
    const onChange = (e: MediaQueryListEvent) => {
      setIsDesktop(e.matches)
      setMobileDrawerOpen(false)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  useEffect(() => {
    if (!isVaultOpen || status !== 'ready' || modalOpen) setMobileDrawerOpen(false)
  }, [isVaultOpen, modalOpen, status])
  useEffect(() => { useAuth.getState().init() }, [])

  /** Single git-status poller shared by the editor UI. */
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
      if (e.key === 'Escape') setConfirmCloseVault(false)
      if ((e.metaKey || e.ctrlKey) && e.key === 'j' && isVaultOpen) { e.preventDefault(); toggleSidebar() }
      if ((e.metaKey || e.ctrlKey) && e.key === 'o') { e.preventDefault(); openVault() }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); openSettings() }
      /** File search — same binding as before, but registered here (App is
       *  always mounted) so it works with the sidebar closed too. */
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'p') && status === 'ready') {
        e.preventDefault()
        if (!isVaultOpen) { toast.error('Open a vault first — press ⌘O'); return }
        openSearch()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [isVaultOpen, openSearch, openSettings, openVault, status, toggleSidebar])

  /** Suppress default browser context menu (Reload, Back, etc.) */
  /** Only in production — dev mode needs right-click for Inspect Element */
  useEffect(() => {
    if (import.meta.env.PROD) {
      const h = (e: MouseEvent) => { if (!e.defaultPrevented) e.preventDefault() }
      window.addEventListener('contextmenu', h)
      return () => window.removeEventListener('contextmenu', h)
    }
  }, [])

  /** Auth gate: checking → setup wizard → login → app. Desktop skips the gate. */
  if (status === 'checking') {
    return <div className="h-screen flex items-center justify-center text-xs text-muted">Loading…</div>
  }
  if (status === 'error') {
    return (
      <div className="h-screen flex flex-col gap-3 items-center justify-center text-xs text-muted">
        <span>Cannot reach server.</span>
        <button onClick={() => void useAuth.getState().init()} className="px-3 py-1.5 rounded cursor-pointer bg-surface-active text-foreground border-none hover:bg-surface-hover">Retry</button>
      </div>
    )
  }
  if (status === 'setup') return <SetupWizard />
  if (status === 'login') return <Login />

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      <div className="flex flex-1 min-h-0">
        {isVaultOpen && isDesktop && desktopSidebarOpen && (
          <Sidebar id="desktop-sidebar" onOpenSettings={openSettings} onOpenSearch={openSearch} onRequestCloseVault={requestCloseVault} registerSearchFolder={registerSearchFolder} />
        )}
        <main className="flex-1 flex flex-col min-w-0 min-h-0">
          <Editor sidebarOpen={sidebarOpen} isDesktop={isDesktop} sidebarToggleRef={sidebarToggleRef} onToggleSidebar={toggleSidebar} onOpenSearch={openSearch} />
        </main>
      </div>

      <Drawer
        id="mobile-sidebar-drawer"
        data-testid="mobile-sidebar-drawer"
        opened={drawerOpen}
        onClose={closeMobileDrawer}
        title="Vault navigation"
        position="left"
        size={224}
        padding={0}
        zIndex={40}
        closeButtonProps={{ 'aria-label': 'Close sidebar drawer', autoFocus: true, icon: <PanelLeftClose size={16} /> }}
        trapFocus
        closeOnEscape
        closeOnClickOutside
        returnFocus={false}
        onExitTransitionEnd={() => {
          if (!isDesktop && !modalOpen) sidebarToggleRef.current?.focus({ preventScroll: true })
        }}
        lockScroll
        classNames={{ overlay: 'mobile-sidebar-drawer-overlay', content: 'mobile-sidebar-drawer-content', header: 'mobile-sidebar-drawer-header', title: 'mobile-sidebar-drawer-title', body: 'mobile-sidebar-drawer-body', close: 'mobile-sidebar-drawer-close' }}
      >
        <Sidebar id="mobile-sidebar" onOpenSettings={openSettings} onOpenSearch={openSearch} onRequestCloseVault={requestCloseVault} onNavigate={closeMobileDrawer} registerSearchFolder={registerSearchFolder} />
      </Drawer>
      {searchOpen && <SearchModal onClose={() => setSearchOpen(false)} onSelect={(p) => searchFolderRef.current(p)} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {confirmCloseVault && (
        <div role="alertdialog" aria-modal="true" aria-label="Close vault" className="fixed inset-0 z-220 flex items-center justify-center bg-black/50" onClick={() => setConfirmCloseVault(false)}>
          <div className="bg-surface border border-border rounded-xl p-4 w-72 shadow-[0_10px_30px_rgba(0,0,0,0.4)]" onClick={e => e.stopPropagation()}>
            <div className="text-sm font-semibold mb-1">Close vault?</div>
            <div className="text-xs text-foreground-secondary mb-4">Unsaved changes will be saved before closing.</div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmCloseVault(false)} className="text-xs px-3 py-1.5 rounded border border-border-subtle bg-transparent text-foreground-secondary cursor-pointer hover:bg-surface-active">Cancel</button>
              <button onClick={async () => { setConfirmCloseVault(false); await useVaultStore.getState().closeVault() }} className="text-xs px-3 py-1.5 rounded bg-danger text-white cursor-pointer border-none">Close</button>
            </div>
          </div>
        </div>
      )}
      <Toaster position="bottom-right" theme="dark" richColors offset={{ bottom: 200, right: 16 }} mobileOffset={{ bottom: 96 }} />
    </div>
  )
}
