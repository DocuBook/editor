// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { flush } from '../harness'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('../../../frontend/lib/ipc', () => ({ invoke, isTauri: false, listen: vi.fn(async () => () => {}) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import SystemSettings from '../../../frontend/components/SystemSettings'

const CONFIG = {
  admin: { email: 'admin@example.com' },
  session_ttl_hours: { value: 12, source: 'config' },
  boot: { port: '8000', data_dir: '/data', www_dir: '/www' },
}

let root: Root | null

function render() {
  root = createRoot(document.getElementById('root')!)
  act(() => root!.render(<SystemSettings />))
}

const buttonByText = (text: string) =>
  Array.from(document.querySelectorAll('button')).find(node => node.textContent?.trim() === text)!

/** The three password fields in render order: current, new, confirm. */
const passwordFields = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]'))

/** React's onChange for a controlled input needs the native setter path. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function fillAllPasswords() {
  const [current, next, confirm] = passwordFields()
  act(() => { type(current, 'old-secret'); type(next, 'new-secret-1'); type(confirm, 'new-secret-1') })
}

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  invoke.mockReset()
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'config_get') return JSON.stringify(CONFIG)
    return undefined
  })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
})

describe('SystemSettings — change password', () => {
  it('keeps the primary button disabled until current, new and confirm are all filled', async () => {
    render()
    await flush()

    const button = buttonByText('Update password')
    expect(button.className).toContain('bg-accent')
    expect(button.className).toContain('text-on-accent')
    expect(button.disabled).toBe(true)

    const [current, next, confirm] = passwordFields()
    act(() => type(current, 'old-secret'))
    expect(button.disabled).toBe(true)
    act(() => type(next, 'new-secret-1'))
    expect(button.disabled).toBe(true)
    act(() => type(confirm, 'new-secret-1'))
    expect(button.disabled).toBe(false)
  })

  it('submits the typed passwords and returns to the disabled state after a change', async () => {
    render()
    await flush()
    fillAllPasswords()

    const button = buttonByText('Update password')
    act(() => button.click())
    await flush()

    expect(invoke).toHaveBeenCalledWith('change_password', { old: 'old-secret', new: 'new-secret-1' })
    expect(passwordFields().every(input => input.value === '')).toBe(true)
    expect(button.disabled).toBe(true)
  })
})

describe('SystemSettings — sign out', () => {
  it('logs out without submitting the password form', async () => {
    render()
    await flush()
    fillAllPasswords()

    act(() => buttonByText('Sign out').click())
    await flush()

    expect(invoke).toHaveBeenCalledWith('logout')
    /** A bare button inside the form would also submit it — and a filled form
     *  would then change the password on the way out. */
    expect(invoke.mock.calls.map(c => c[0])).not.toContain('change_password')
  })
})
