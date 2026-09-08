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
  Drawer: ({ opened, onClose, onExitTransitionEnd, children }: { opened: boolean; onClose: () => void; onExitTransitionEnd?: () => void; children?: ReactNode }) => {
    const wasOpened = useRef(false)
    useEffect(() => {
      if (wasOpened.current && !opened) onExitTransitionEnd?.()
      wasOpened.current = opened
    }, [onExitTransitionEnd, opened])
    return (
      <section data-testid="drawer" data-opened={String(opened)}>
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
vi.mock('../../../frontend/components/SettingsModal', () => ({ default: () => <div data-testid="settings" /> }))
vi.mock('../../../frontend/components/StatusBar', () => ({ default: () => null }))
vi.mock('../../../frontend/components/SetupWizard', () => ({ default: () => null }))
vi.mock('../../../frontend/components/Login', () => ({ default: () => null }))
vi.mock('../../../frontend/stores/gitStatus', () => ({ useGitPolling: () => {} }))
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
vi.mock('../../../frontend/lib/ipc', () => ({ listen: vi.fn(async () => () => {}), invoke: vi.fn() }))
vi.mock('../../../frontend/utils/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('sonner', () => ({ Toaster: () => null, toast: { error: vi.fn() } }))

import App from '../../../frontend/App'

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

  it('closes and blocks mobile drawer while a competing modal is open', () => {
    act(() => setDesktop(false))
    const toggle = document.querySelector<HTMLButtonElement>('[aria-label="toggle-sidebar"]')!
    act(() => toggle.click())
    expect(document.getElementById('mobile-sidebar')).not.toBeNull()

    act(() => document.querySelector<HTMLButtonElement>('[aria-label="sidebar-settings"]')!.click())
    expect(document.querySelector('[data-testid="settings"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="drawer"]')?.getAttribute('data-opened')).toBe('false')

    act(() => toggle.click())
    expect(document.querySelector('[data-testid="drawer"]')?.getAttribute('data-opened')).toBe('false')
  })
})
