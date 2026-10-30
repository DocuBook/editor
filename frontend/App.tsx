import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Drawer } from '@mantine/core'
import { PanelLeftClose } from 'lucide-react'
import Sidebar from './components/Sidebar'
import SearchModal from './components/SearchModal'
import Editor from './components/Editor'
import SettingsPane from './components/SettingsPane'
import { SettingsHeader } from './components/SettingsHeader'
import ShortcutsModal from './components/ShortcutsModal'
import { Toaster, toast } from 'sonner'

import { useGitStatusRefresh } from './stores/gitStatus'
import { useEditorStore, installUnloadSave } from './stores/editor'
import { useVaultStore } from './stores/vault'
import { useSyncStore, installSyncListeners, isSyncRecordInScope } from './stores/sync'
import ConflictDialog from './components/ConflictDialog'
import SyncStatusBadge from './components/editor/SyncStatusBadge'
import { listen, invoke, closeWindow, isTauri } from './lib/ipc'
import { useAuth, useAuthGuard } from './stores/auth'
import SetupWizard from './components/SetupWizard'
import Login from './components/Login'
import { logger } from './utils/logger'
import { useTheme } from './stores/theme'
import { hydrateAiSettings } from './stores/aiSettings'
import { useSettings } from './stores/settings'

/** Root application component with keyboard shortcuts. */
export default function App() {
  const { status } = useAuth()
  const colorScheme = useTheme(s => s.colorScheme)
  const isVaultOpen = useVaultStore(s => s.isOpen)
  const vaultPath = useVaultStore(s => s.vaultPath)
  const openVault = useVaultStore(s => s.openVault)
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia('(min-width: 640px)').matches)
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true)
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false)
  /** Settings now lives in the editor container, not a dialog. The store is the
   *  single flag every entry point drives (sidebar tree, profile menu, ⌘,). */
  const settingsOpen = useSettings(s => s.open)
  const openSettingsStore = useSettings(s => s.openSettings)
  /** Search lives here (not in Sidebar) so ⌘F/⌘P and the modal keep working
   *  with the sidebar closed — Sidebar unmounts when hidden. */
  const [searchOpen, setSearchOpen] = useState(false)
  /** Shortcuts lives here (not in Sidebar) for the same reason: on mobile it
   *  must close the drawer and render outside it, like search/settings. */
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [confirmCloseVault, setConfirmCloseVault] = useState(false)
  /** Current create-target folder lives in Sidebar; the modal's onSelect only
   *  needs it while the sidebar is mounted, so Sidebar registers its setter. */
  const searchFolderRef = useRef<(path: string) => void>(() => {})
  const sidebarToggleRef = useRef<HTMLButtonElement>(null)
  const registerSearchFolder = useCallback((fn: (path: string) => void) => {
    searchFolderRef.current = fn
    return () => { if (searchFolderRef.current === fn) searchFolderRef.current = () => {} }
  }, [])
  /** Settings is NOT a modal: it renders in the editor container and leaves the
   *  workspace interactive, so it is deliberately absent here. The mobile drawer
   *  may stay open over the pane, so the settings tree remains reachable for
   *  further navigation — the external entry points (⌘, / profile menu) close the
   *  drawer themselves when they open the pane. */
  const modalOpen = searchOpen || shortcutsOpen || confirmCloseVault
  const sidebarOpen = isDesktop ? desktopSidebarOpen : mobileDrawerOpen
  const drawerOpen = !isDesktop && isVaultOpen && status === 'ready' && mobileDrawerOpen && !modalOpen
  const closeMobileDrawer = useCallback(() => setMobileDrawerOpen(false), [])
  const toggleSidebar = useCallback(() => {
    if (!isVaultOpen || status !== 'ready') return
    if (isDesktop) setDesktopSidebarOpen(open => !open)
    else if (!modalOpen) setMobileDrawerOpen(open => !open)
  }, [isDesktop, isVaultOpen, modalOpen, status])
  const openSearch = useCallback(() => {
    setMobileDrawerOpen(false); setShortcutsOpen(false); setConfirmCloseVault(false); setSearchOpen(true)
  }, [])
  const openSettings = useCallback(() => {
    setMobileDrawerOpen(false); setSearchOpen(false); setShortcutsOpen(false); setConfirmCloseVault(false); openSettingsStore()
  }, [openSettingsStore])
  const openShortcuts = useCallback(() => {
    setMobileDrawerOpen(false); setSearchOpen(false); setConfirmCloseVault(false); setShortcutsOpen(true)
  }, [])

  const requestCloseVault = useCallback(() => {
    setMobileDrawerOpen(false); setSearchOpen(false); setShortcutsOpen(false); setConfirmCloseVault(true)
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
  /* oxlint-disable react/set-state-in-effect -- closes the drawer when the vault/modal state changes */
  useEffect(() => {
    if (!isVaultOpen || status !== 'ready' || modalOpen) setMobileDrawerOpen(false)
  }, [isVaultOpen, modalOpen, status])
  /* oxlint-enable react/set-state-in-effect */
  useEffect(() => { useAuth.getState().init() }, [])

  /** AI connection data lives in the backend's config.json — the browser keeps no
   *  copy across sessions (no persist middleware), so it must be fetched once
   *  before anything renders a provider or a model, AND only once the session is
   *  authenticated: /api/ai_settings answers 401 to a bare browser, and a silent
   *  hydration failure at boot would leave a fresh browser (new device / new
   *  browser) with an empty store — a disabled composer that looks like it holds
   *  another session's state while the server actually has the config. Gating on
   *  `ready` also re-hydrates after a re-login, picking up config saved elsewhere. */
  useEffect(() => {
    if (status !== 'ready') return
    let cancelled = false
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    const hydrate = async () => {
      if (await hydrateAiSettings() || cancelled || attempt >= 3) return
      const delay = 1000 * 2 ** attempt
      attempt += 1
      timer = setTimeout(() => { void hydrate() }, delay)
    }

    void hydrate()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [status])

  /** Single event-driven git-status refresher shared by the editor UI — runs on
   *  git actions, vault open/close, and window focus (no interval). */
  useGitStatusRefresh()
  /** AI settings refresher — ONE listener for the whole app, attached here rather
   *  than inside each ProviderForm (three instances meant three listener pairs).
   *  A change made in another browser/tab is otherwise invisible until a save or
   *  revoke happens to refresh: the server is authoritative but never pushes. Same
   *  event-driven, no-interval pattern as the git-status refresher. Deliberately
   *  NOT gated on the settings surface being open — the composer, transport and
   *  auto-commit consume this store while Settings is closed. */
  useEffect(() => {
    const refresh = () => void hydrateAiSettings()
    const onVisibility = () => { if (document.visibilityState === 'visible') refresh() }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
  useAuthGuard()

  const conflicts = useSyncStore(s => s.conflicts)
  /** Only conflicts raised by the vault that is open now. The store is shared
   *  across vaults (queued writes must survive a switch), so the UI has to
   *  filter — a relative path from another vault names a different file. */
  const scopedConflicts = useMemo(
    () => conflicts.filter(c => isSyncRecordInScope(c, vaultPath)),
    [conflicts, vaultPath],
  )
  /** Paths the user dismissed with "Decide later". The conflict stays in the
   *  store (nothing is lost) but stops re-opening the dialog unprompted; the
   *  status badge keeps showing it so it cannot be forgotten. */
  const [dismissedConflicts, setDismissedConflicts] = useState<Record<string, true>>({})
  const conflictIdentity = (conflict: typeof conflicts[number]) => conflict.id
  const activeConflict = scopedConflicts.find(c => !dismissedConflicts[conflictIdentity(c)])
  const resolveConflict = useCallback(async (choice: 'mine' | 'theirs') => {
    const path = useSyncStore.getState().conflicts.find(c => !dismissedConflicts[conflictIdentity(c)] && isSyncRecordInScope(c, vaultPath))?.path
    if (!path) return
    const editor = useEditorStore.getState()
    if (choice === 'mine') await editor.applyConflictMine(path)
    else await editor.applyConflictTheirs(path)
  }, [dismissedConflicts, vaultPath])

  /** Offline queue: drain when connectivity returns or auth/vault becomes ready. */
  useEffect(() => installSyncListeners(() => useAuth.getState().status === 'ready' && useVaultStore.getState().isOpen), [])
  useEffect(() => {
    if (status === 'ready' && isVaultOpen) void useSyncStore.getState().drain()
  }, [status, isVaultOpen])

  /** The browser tab has no close handshake: save on hide and before unload. */
  useEffect(() => (isTauri ? undefined : installUnloadSave()), [])

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

  /** Cmd+W arrives as a menu event: the native menu no longer closes the
   *  window, it lets the frontend decide. Close the active tab, and only fall
   *  back to closing the window once no tab is left — otherwise the shortcut
   *  would silently become dead. */
  useEffect(() => {
    let unsub: (() => void) | undefined
    let cancelled = false
    listen('app:close-tab', () => {
      const { activeTab, closeTab } = useEditorStore.getState()
      if (activeTab) { void closeTab(activeTab); return }
      void closeWindow().catch(error => logger.error('app_close_failed', { error }))
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
    <div className="editor-shell h-screen overflow-hidden flex flex-col bg-background text-foreground">
      <div className="flex flex-1 min-h-0">
        {isVaultOpen && isDesktop && desktopSidebarOpen && (
          <Sidebar id="desktop-sidebar" onOpenSettings={openSettings} onOpenSearch={openSearch} onOpenShortcuts={openShortcuts} onRequestCloseVault={requestCloseVault} registerSearchFolder={registerSearchFolder} />
        )}
        <main className="flex-1 flex flex-col min-w-0 min-h-0">
          <SyncStatusBadge />
          {/* Settings swaps into the editor container — the workspace stays
              mounted (no dialog), so the sidebar tree can keep driving it. On
              mobile the editor's TabBar (whose sidebar toggle opened the drawer)
              is gone, so a matching header carries the same toggle — otherwise
              the user is stranded in Settings with no way back to the tree. */}
          {settingsOpen
            ? <>
                {!isDesktop && <SettingsHeader sidebarOpen={sidebarOpen} sidebarToggleRef={sidebarToggleRef} onToggleSidebar={toggleSidebar} onOpenSearch={openSearch} />}
                <SettingsPane />
              </>
            : <Editor sidebarOpen={sidebarOpen} isDesktop={isDesktop} sidebarToggleRef={sidebarToggleRef} onToggleSidebar={toggleSidebar} onOpenSearch={openSearch} />}
        </main>
      </div>

      {/* 70% of the viewport: on a phone the drawer is the primary navigation
          surface, and the old fixed 224px truncated every folder name. */}
      <Drawer
        id="mobile-sidebar-drawer"
        data-testid="mobile-sidebar-drawer"
        opened={drawerOpen}
        onClose={closeMobileDrawer}
        title="Vault navigation"
        position="left"
        size="70%"
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
        <Sidebar id="mobile-sidebar" onOpenSettings={openSettings} onOpenSearch={openSearch} onOpenShortcuts={openShortcuts} onRequestCloseVault={requestCloseVault} onNavigate={closeMobileDrawer} registerSearchFolder={registerSearchFolder} />
      </Drawer>
      {searchOpen && <SearchModal onClose={() => setSearchOpen(false)} onSelect={(p) => searchFolderRef.current(p)} />}
      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
      {confirmCloseVault && (
        <div role="alertdialog" aria-modal="true" aria-label="Close vault" className="fixed inset-0 z-220 flex items-center justify-center ui-backdrop" onClick={() => setConfirmCloseVault(false)}>
          <div className="ui-popover p-4 w-72" onClick={e => e.stopPropagation()}>
            <div className="text-sm font-semibold mb-1">Close vault?</div>
            <div className="text-xs text-foreground-secondary mb-4">Unsaved changes will be saved before closing.</div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmCloseVault(false)} className="text-xs px-3 py-1.5 rounded border border-border-subtle bg-transparent text-foreground-secondary cursor-pointer hover:bg-surface-active">Cancel</button>
              <button onClick={async () => { setConfirmCloseVault(false); await useVaultStore.getState().closeVault() }} className="text-xs px-3 py-1.5 rounded bg-danger text-on-danger cursor-pointer border-none">Close</button>
            </div>
          </div>
        </div>
      )}
      {activeConflict && (
        <ConflictDialog
          key={activeConflict.path}
          conflict={activeConflict}
          onResolve={resolveConflict}
          onClose={() => setDismissedConflicts(prev => ({ ...prev, [conflictIdentity(activeConflict)]: true }))}
        />
      )}
      {/* `expand` keeps concurrent toasts spread out (one above the other) instead
          of sonner's default collapsed stack, where they overlap until hovered.
          `closeButton` gives every toast an X, so one can be dismissed before its
          timer runs out (sonner leaves it off loading toasts). */}
      <Toaster position="bottom-right" theme={colorScheme} richColors expand closeButton offset={{ bottom: 80, right: 16 }} mobileOffset={{ bottom: 96 }} />
    </div>
  )
}
