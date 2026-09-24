// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import PermissionDialog from '../../../frontend/components/PermissionDialog'

const openSystemSettings = vi.hoisted(() => vi.fn())
vi.mock('../../../frontend/lib/ipc', async importOriginal => ({
  ...await importOriginal<typeof import('../../../frontend/lib/ipc')>(),
  openSystemSettings,
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | null

const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')!
const button = (text: string) => Array.from(dialog().querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === text)!

function renderDialog(overrides: Partial<{ pane: 'accessibility' | 'automation' | 'files'; message: string; detail: string; onClose: () => void }> = {}) {
  const props = {
    pane: 'accessibility' as const,
    message: 'Put Back needs Accessibility access to move items out of the Trash.',
    onClose: vi.fn(),
    ...overrides,
  }
  root = createRoot(document.getElementById('root')!)
  act(() => root!.render(<PermissionDialog {...props} />))
  return props
}

beforeEach(() => { document.body.innerHTML = '<div id="root"></div>' })
afterEach(() => { if (root) act(() => root!.unmount()); root = null; vi.clearAllMocks() })

describe('PermissionDialog', () => {
  it('names the exact pane the user must enable', () => {
    renderDialog()

    expect(dialog().textContent).toContain('Accessibility')
    expect(dialog().textContent).toContain('Privacy & Security')
    expect(dialog().textContent).toContain('Put Back needs Accessibility access')
  })

  /** The mobile sidebar drawer transforms its content, which would make the
   *  drawer the containing block of a `fixed` in-tree dialog and clip it down to
   *  the drawer — so the dialog is portaled to document.body instead. */
  it('renders outside the component tree so no transformed ancestor can clip it', () => {
    renderDialog()

    expect(dialog().parentElement).toBe(document.body)
  })

  it('labels the pane for each permission kind', () => {
    renderDialog({ pane: 'automation' })
    expect(dialog().textContent).toContain('Automation')

    act(() => root!.unmount())
    renderDialog({ pane: 'files' })
    expect(dialog().textContent).toContain('Full Disk Access')
  })

  it('shows the raw failure as monospace detail when provided', () => {
    renderDialog({ detail: 'Trash: -1743' })
    expect(dialog().textContent).toContain('Trash: -1743')
  })

  it('closes without opening anything when the user declines', () => {
    const props = renderDialog()
    act(() => button('Not now').click())

    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape and on backdrop click', () => {
    const props = renderDialog()
    act(() => dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    act(() => dialog().click())

    expect(props.onClose).toHaveBeenCalledTimes(2)
  })

  it('ignores Escape from inside the panel and clicks on its content', () => {
    const props = renderDialog()
    const panel = dialog().firstElementChild as HTMLElement
    act(() => panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    act(() => panel.click())

    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('opens the pane and closes when the deep link succeeds', async () => {
    openSystemSettings.mockResolvedValue(true)
    const props = renderDialog()

    await act(async () => button('Open System Settings').click())

    expect(openSystemSettings).toHaveBeenCalledWith('accessibility')
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  /** The deep link is the only thing the user clicked, so a silent failure would
   *  look like a dead button — the written path has to stay on screen. */
  it('stays open and explains itself when the deep link fails', async () => {
    openSystemSettings.mockResolvedValue(false)
    const props = renderDialog()

    await act(async () => button('Open System Settings').click())

    expect(props.onClose).not.toHaveBeenCalled()
    expect(dialog().textContent).toContain('could not be opened automatically')
    expect(dialog().textContent).toContain('Privacy & Security › Accessibility')
  })
})
