// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProfileMenu from '../../../frontend/components/ProfileMenu'
import { useAuth } from '../../../frontend/stores/auth'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | null = null
const props = (overrides: Partial<React.ComponentProps<typeof ProfileMenu>> = {}) => ({
  isNative: false,
  onOpenSettings: vi.fn(),
  onOpenShortcuts: vi.fn(),
  onLogout: vi.fn(),
  ...overrides,
})

function renderMenu(componentProps = props()) {
  root = createRoot(document.getElementById('root')!)
  act(() => root!.render(<ProfileMenu {...componentProps} />))
}

function openMenu() {
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Open profile menu"]')!.click())
}

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  useAuth.setState({ email: 'member@example.com' })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  useAuth.setState({ email: '' })
  vi.clearAllMocks()
})

describe('ProfileMenu', () => {
  it('shows account email in profile trigger and menu', () => {
    renderMenu()
    expect(document.querySelector('[aria-label="Open profile menu"]')?.textContent).toContain('member@example.com')

    openMenu()
    expect(document.body.textContent).toContain('member@example.com')
  })

  it('keeps workspace actions visible but disabled', () => {
    renderMenu()
    openMenu()

    for (const label of ['Invite members', 'New workspace']) {
      const button = Array.from(document.querySelectorAll('button')).find(item => item.textContent?.includes(label))
      expect(button?.disabled).toBe(true)
    }
  })

  it('opens shortcuts and settings dialogs through callbacks', () => {
    const onOpenShortcuts = vi.fn()
    const onOpenSettings = vi.fn()
    renderMenu(props({ onOpenShortcuts, onOpenSettings }))
    openMenu()

    act(() => Array.from(document.querySelectorAll('button')).find(button => button.textContent?.includes('Keyboard shortcuts'))!.click())
    expect(onOpenShortcuts).toHaveBeenCalledOnce()

    openMenu()
    act(() => Array.from(document.querySelectorAll('button')).find(button => button.textContent?.includes('Settings'))!.click())
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('dismisses on outside pointer and Escape, restoring focus on Escape', () => {
    renderMenu()
    openMenu()
    expect(document.body.textContent).toContain('Invite members')

    act(() => document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    expect(document.body.textContent).not.toContain('Invite members')

    openMenu()
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.body.textContent).not.toContain('Invite members')
    expect(document.activeElement).toBe(document.querySelector('[aria-label="Open profile menu"]'))
  })

  it('focuses the first enabled menu action when opened', () => {
    renderMenu()
    openMenu()
    expect(document.activeElement?.textContent).toContain('Keyboard shortcuts')
  })

  it('shows logout only for web and invokes its callback', () => {
    const onLogout = vi.fn()
    renderMenu(props({ onLogout }))
    openMenu()
    const logout = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.includes('Log out'))
    expect(logout).toBeDefined()
    act(() => logout!.click())
    expect(onLogout).toHaveBeenCalledOnce()

    act(() => root!.unmount())
    renderMenu(props({ isNative: true, onLogout }))
    openMenu()
    expect(Array.from(document.querySelectorAll('button')).some(button => button.textContent?.includes('Log out'))).toBe(false)
    expect(onLogout).toHaveBeenCalledOnce()
  })

  it('closes on outside interaction and Escape', () => {
    renderMenu()
    openMenu()
    expect(document.body.textContent).toContain('Keyboard shortcuts')

    act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(document.body.textContent).not.toContain('Keyboard shortcuts')

    openMenu()
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.body.textContent).not.toContain('Keyboard shortcuts')
  })

  it('focuses the first enabled action and restores focus to the trigger', () => {
    renderMenu()
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Open profile menu"]')!
    openMenu()
    expect(document.activeElement?.textContent).toContain('Keyboard shortcuts')

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.activeElement).toBe(trigger)
  })
})
