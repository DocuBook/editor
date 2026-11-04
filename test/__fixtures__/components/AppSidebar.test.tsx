// @vitest-environment jsdom

import { act, useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The desktop close handshake: `app:before-close` handlers captured from `listen`. */
const closeHandshake = vi.hoisted(() => ({
  handlers: new Map<string, () => Promise<void>>(),
  persistAllDirty: vi.fn(async () => {}),
  confirmDeletedEdits: vi.fn(async () => true),
}))
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
vi.mock('../../../frontend/components/DeletedEditsDialog', () => ({ default: () => null }))
vi.mock('../../../frontend/components/SetupWizard', () => ({ default: () => null }))
vi.mock('../../../frontend/components/Login', () => ({ default: () => null }))
vi.mock('../../../frontend/stores/gitStatus', () => ({ useGitStatusRefresh: () => {} }))
vi.mock('../../../frontend/stores/editor', () => ({
  useEditorStore: { getState: () => ({ persistAllDirty: closeHandshake.persistAllDirty, confirmDeletedEdits: closeHandshake.confirmDeletedEdits }) },
  installUnloadSave: () => () => {},
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
vi.mock('../../../frontend/lib/ipc', () => ({
  isTauri: false,
  listen: vi.fn(async (event: string, handler: () => Promise<void>) => { closeHandshake.handlers.set(event, handler); return () => {} }),
  invoke: vi.fn(),
}))
vi.mock('../../../frontend/utils/logger', () => ({ logger: { error: vi.fn() } }))
/* The real Toaster, so the toast describe below exercises what App configures. */
vi.mock('sonner', async (importOriginal) => ({ ...(await importOriginal<typeof import('sonner')>()), toast: { error: vi.fn() } }))

import App from '../../../frontend/App'
import { useSettings } from '../../../frontend/stores/settings'
import { invoke } from '../../../frontend/lib/ipc'
import { toast as sonnerToast } from 'sonner'

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

describe('toasts', () => {
  /** Every toast carries an X, so a message can be cleared before its timer runs
   *  out — on a phone one sits over the composer's Cancel/Retry bar. */
  it('dismisses a toast from its close button', async () => {
    const { toast } = await vi.importActual<typeof import('sonner')>('sonner')
    act(() => { toast.error('AI request failed. Please retry.') })
    const close = await vi.waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-sonner-toast] [data-close-button]')
      expect(button).not.toBeNull()
      return button!
    })
    expect(close.getAttribute('aria-label')).toBe('Close toast')

    act(() => close.click())
    await vi.waitFor(() => expect(document.querySelector('[data-sonner-toast]')).toBeNull())
  })
})

/** The backend's handshake is one-shot: it lets the next window close straight
 *  through unless the frontend re-arms it with `app_cancel_close`. So every way
 *  of staying open has to say so, or the following close skips the save and the
 *  deleted-tab prompt. */
describe('desktop close handshake', () => {
  const beforeClose = () => closeHandshake.handlers.get('app:before-close')!
  const calls = (cmd: string) => vi.mocked(invoke).mock.calls.filter(([name]) => name === cmd)
  beforeEach(() => {
    closeHandshake.persistAllDirty.mockReset().mockResolvedValue(undefined)
    closeHandshake.confirmDeletedEdits.mockReset().mockResolvedValue(true)
    vi.mocked(invoke).mockReset().mockResolvedValue(undefined)
  })

  it('closes the window once everything is saved, without re-arming', async () => {
    await act(async () => { await beforeClose()() })
    expect(calls('app_ready_to_close')).toHaveLength(1)
    expect(calls('app_cancel_close')).toHaveLength(0)
  })

  it('acknowledges the close before it asks or saves, so a second close is held', async () => {
    const order: string[] = []
    vi.mocked(invoke).mockImplementation(async (cmd: string) => { order.push(cmd) })
    closeHandshake.confirmDeletedEdits.mockImplementation(async () => { order.push('confirm'); return true })
    closeHandshake.persistAllDirty.mockImplementation(async () => { order.push('save') })
    await act(async () => { await beforeClose()() })
    expect(order).toEqual(['app_close_ack', 'confirm', 'save', 'app_ready_to_close'])
  })

  it('re-arms and stays open when the user cancels, so the next close asks again', async () => {
    closeHandshake.confirmDeletedEdits.mockResolvedValue(false)
    await act(async () => { await beforeClose()() })
    expect(calls('app_ready_to_close')).toHaveLength(0)
    expect(calls('app_cancel_close')).toHaveLength(1)

    await act(async () => { await beforeClose()() })
    expect(closeHandshake.confirmDeletedEdits).toHaveBeenCalledTimes(2)
    expect(calls('app_cancel_close')).toHaveLength(2)
  })

  it('re-arms when a save fails, so the next close saves again', async () => {
    closeHandshake.persistAllDirty.mockRejectedValue(new Error('disk full'))
    await act(async () => { await beforeClose()() })
    expect(vi.mocked(sonnerToast.error)).toHaveBeenCalled()
    expect(calls('app_ready_to_close')).toHaveLength(0)
    expect(calls('app_cancel_close')).toHaveLength(1)
  })

  it('re-arms when the backend refuses to close', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => { if (cmd === 'app_ready_to_close') throw new Error('close failed') })
    await act(async () => { await beforeClose()() })
    expect(calls('app_cancel_close')).toHaveLength(1)
  })
})
