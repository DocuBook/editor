// @vitest-environment jsdom

import { act, useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const vaultState = vi.hoisted(() => ({
  isOpen: true,
  openVault: vi.fn(async () => {}),
  closeVault: vi.fn(async () => {}),
}))

vi.mock('@mantine/core', () => ({
  Drawer: ({ opened, onClose, onExitTransitionEnd, size, children }: { opened: boolean; onClose: () => void; onExitTransitionEnd?: () => void; size?: number | string; children?: ReactNode }) => {
    const wasOpened = useRef(false)
    useEffect(() => {
      if (wasOpened.current && !opened) onExitTransitionEnd?.()
      wasOpened.current = opened
    }, [onExitTransitionEnd, opened])
    return (
      <section data-testid="drawer" data-opened={String(opened)} data-size={String(size)}>
        {opened && <><button aria-label="close-drawer" onClick={onClose}>Close</button>{children}</>}
      </section>
    )
  },
}))
vi.mock('../../../frontend/components/Sidebar', () => ({
  default: ({ id, onOpenSettings }: { id?: string; onOpenSettings: () => void }) => (
    <aside id={id}><button aria-label="sidebar-settings" onClick={onOpenSettings}>Settings</button></aside>
  ),
}))
vi.mock('../../../frontend/components/Editor', () => ({
  default: ({ sidebarOpen, isDesktop, sidebarToggleRef, onToggleSidebar }: { sidebarOpen: boolean; isDesktop: boolean; sidebarToggleRef: RefObject<HTMLButtonElement | null>; onToggleSidebar: () => void }) => (
    <button ref={sidebarToggleRef} aria-label="toggle-sidebar" data-open={String(sidebarOpen)} data-desktop={String(isDesktop)} onClick={onToggleSidebar}>Toggle</button>
  ),
}))
vi.mock('../../../frontend/components/SearchModal', () => ({ default: () => <div data-testid="search" /> }))
vi.mock('../../../frontend/components/SettingsPane', () => ({ default: () => <div data-testid="settings" /> }))
vi.mock('../../../frontend/components/SettingsHeader', () => ({
  SettingsHeader: ({ sidebarToggleRef, onToggleSidebar, sidebarOpen }: { sidebarToggleRef: RefObject<HTMLButtonElement | null>; onToggleSidebar: () => void; sidebarOpen: boolean }) => (
    <button ref={sidebarToggleRef} aria-label="settings-toggle-sidebar" data-open={String(sidebarOpen)} onClick={onToggleSidebar}>Toggle</button>
  ),
}))
vi.mock('../../../frontend/components/StatusBar', () => ({ default: () => null }))
vi.mock('../../../frontend/components/SetupWizard', () => ({ default: () => null }))
vi.mock('../../../frontend/components/Login', () => ({ default: () => null }))
vi.mock('../../../frontend/stores/gitStatus', () => ({ useGitStatusRefresh: () => {} }))
vi.mock('../../../frontend/stores/editor', () => ({
  useEditorStore: { getState: () => ({ persistAllDirty: vi.fn(async () => {}) }) },
}))
vi.mock('../../../frontend/stores/vault', () => ({
  useVaultStore: Object.assign(
    <T,>(selector: (state: typeof vaultState) => T) => selector(vaultState),
    { getState: () => vaultState },
  ),
}))
vi.mock('../../../frontend/stores/auth', () => ({
  useAuth: Object.assign(() => ({ status: 'ready' }), { getState: () => ({ init: vi.fn() }) }),
  useAuthGuard: () => {},
}))
vi.mock('../../../frontend/lib/ipc', () => ({ isTauri: false, listen: vi.fn(async () => () => {}), invoke: vi.fn() }))
vi.mock('../../../frontend/utils/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('sonner', () => ({ Toaster: () => null, toast: { error: vi.fn() } }))

import App from '../../../frontend/App'
import { useSettings } from '../../../frontend/stores/settings'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

type MediaListener = (event: MediaQueryListEvent) => void
let root: Root
let desktop = true
let mediaListeners: Set<MediaListener>

function setDesktop(matches: boolean) {
  desktop = matches
  for (const listener of mediaListeners) listener({ matches } as MediaQueryListEvent)
}

beforeEach(() => {
  mediaListeners = new Set()
  desktop = true
  useSettings.setState({ open: false, section: 'ai-provider' })
  document.body.innerHTML = '<div id="root"></div>'
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: desktop,
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: MediaListener) => mediaListeners.add(listener),
    removeEventListener: (_type: string, listener: MediaListener) => mediaListeners.delete(listener),
    addListener: (listener: MediaListener) => mediaListeners.add(listener),
    removeListener: (listener: MediaListener) => mediaListeners.delete(listener),
    dispatchEvent: () => true,
  }))
  root = createRoot(document.getElementById('root')!)
  act(() => root.render(<App />))
})

afterEach(() => {
  act(() => root.unmount())
  vi.clearAllMocks()
})

describe('responsive sidebar', () => {
  it('preserves desktop collapse preference while mobile drawer starts closed', () => {
    const toggle = () => document.querySelector<HTMLButtonElement>('[aria-label="toggle-sidebar"]')!

    expect(document.getElementById('desktop-sidebar')).not.toBeNull()
    act(() => toggle().click())
    expect(document.getElementById('desktop-sidebar')).toBeNull()

    act(() => setDesktop(false))
    expect(toggle().dataset.open).toBe('false')
    act(() => toggle().click())
    expect(document.querySelector('[data-testid="drawer"]')?.getAttribute('data-opened')).toBe('true')

    act(() => setDesktop(true))
    expect(document.getElementById('desktop-sidebar')).toBeNull()
    expect(toggle().dataset.open).toBe('false')
  })

  it('restores focus to the mobile toggle after the drawer exit transition', () => {
    act(() => setDesktop(false))
    const toggle = document.querySelector<HTMLButtonElement>('[aria-label="toggle-sidebar"]')!
    act(() => toggle.click())
    const close = document.querySelector<HTMLButtonElement>('[aria-label="close-drawer"]')!
    act(() => { close.focus(); close.click() })

    expect(document.activeElement).toBe(toggle)
  })

  /** Settings is opened by the profile menu / ⌘, (the store), NOT a sidebar tab.
   *  Because Settings is not a blocking modal, the drawer stays usable from the
   *  Settings surface too: opening it, then toggling again, re-opens the drawer. */
  it('lets the Settings header re-open the mobile drawer over the pane', () => {
    act(() => setDesktop(false))
    // Reach Settings the mobile way: through the drawer's profile menu.
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="toggle-sidebar"]')!.click())
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="sidebar-settings"]')!.click())
    expect(document.querySelector('[data-testid="settings"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="drawer"]')?.getAttribute('data-opened')).toBe('false')

    // The editor mock is unmounted; the Settings header's own toggle now drives
    // the SAME App-owned drawer state (it is not a modal, so nothing blocks it).
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="settings-toggle-sidebar"]')!.click())
    expect(document.querySelector('[data-testid="drawer"]')?.getAttribute('data-opened')).toBe('true')
  })

  /** The regression this fixes: the editor's TabBar carried the ONLY sidebar
   *  toggle, and it unmounts when Settings opens — so on a phone the user was
   *  stranded in Settings with no control to reach the navigation drawer. The
   *  Settings header must provide that control in the editor's absence. */
  it('offers a sidebar toggle in Settings once the editor unmounts', () => {
    act(() => setDesktop(false))

    act(() => useSettings.getState().openSettings())
    expect(document.querySelector('[data-testid="settings"]')).not.toBeNull()
    // The editor (and its TabBar toggle) is gone...
    expect(document.querySelector('[aria-label="toggle-sidebar"]')).toBeNull()

    // ...but the Settings header keeps a live toggle that opens the drawer.
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="settings-toggle-sidebar"]')!.click())
    expect(document.querySelector('[data-testid="drawer"]')?.getAttribute('data-opened')).toBe('true')
  })

  /** The drawer is the whole navigation surface on a phone, so it takes most of
   *  the viewport instead of a fixed column that truncated every folder name. */
  it('sizes the mobile drawer to 70% of the viewport', () => {
    act(() => setDesktop(false))
    const toggle = document.querySelector<HTMLButtonElement>('[aria-label="toggle-sidebar"]')!
    act(() => toggle.click())

    expect(document.querySelector('[data-testid="drawer"]')?.getAttribute('data-size')).toBe('70%')
  })

  /** Settings is opened by the profile menu / ⌘, (the store), NOT a sidebar tab.
   *  Because Settings is not a blocking modal, the mobile drawer may stay open
   *  over the pane so the settings tree remains reachable on a phone. */
  it('keeps the mobile drawer reachable when Settings is opened', () => {
    act(() => setDesktop(false))
    const toggle = document.querySelector<HTMLButtonElement>('[aria-label="toggle-sidebar"]')!
    act(() => toggle.click())
    expect(document.getElementById('mobile-sidebar')).not.toBeNull()

    act(() => useSettings.getState().openSettings('git-identity'))

    expect(document.querySelector('[data-testid="settings"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="drawer"]')?.getAttribute('data-opened')).toBe('true')
  })
})
