// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { flush } from '../harness'

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: false }))
vi.mock('../../../frontend/lib/ipc', () => ipc)
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))

import GitCredentials from '../../../frontend/components/GitCredentials'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | null

function render() {
  root = createRoot(document.getElementById('root')!)
  act(() => root!.render(<GitCredentials />))
}

const field = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
const saveButton = () => Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Save')!

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const listing = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ encryption: true, credentials: [{ host: 'github.com', username: 'me' }], error: '', ...overrides })

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  ipc.invoke.mockReset()
  ipc.isTauri = false
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
})

describe('GitCredentials (web)', () => {
  it('lists hosts and usernames without any token field value', async () => {
    ipc.invoke.mockResolvedValue(listing())
    render()
    await flush()

    expect(document.body.textContent).toContain('github.com')
    expect(document.body.textContent).toContain('me')
    expect(field('Access token').type).toBe('password')
    expect(field('Access token').value).toBe('')
  })

  it('saves a token, then clears it from the page', async () => {
    ipc.invoke.mockImplementation(async (command: string) =>
      command === 'git_set_credential' ? JSON.stringify({ host: 'gitlab.com' }) : listing())
    render()
    await flush()

    type(field('Host'), 'gitlab.com')
    type(field('Username'), 'oauth2')
    type(field('Access token'), 'glpat-secret')
    act(() => saveButton().click())
    await flush()

    expect(ipc.invoke).toHaveBeenCalledWith('git_set_credential', { host: 'gitlab.com', username: 'oauth2', token: 'glpat-secret' })
    expect(field('Access token').value).toBe('')
  })

  it('locks the form until encryption is configured', async () => {
    ipc.invoke.mockResolvedValue(listing({ encryption: false, credentials: [] }))
    render()
    await flush()

    expect(document.body.textContent).toContain('DB_KEYS_PASSPHRASE')
    expect(field('Access token').disabled).toBe(true)
    expect(saveButton().disabled).toBe(true)
  })

  it('removes a stored token by host', async () => {
    ipc.invoke.mockResolvedValue(listing())
    render()
    await flush()

    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Remove token for github.com"]')!.click())
    await flush()

    expect(ipc.invoke).toHaveBeenCalledWith('git_delete_credential', { host: 'github.com' })
  })
})

describe('GitCredentials (desktop)', () => {
  it('explains the system Git setup instead of storing tokens', async () => {
    ipc.isTauri = true
    render()
    await flush()

    expect(ipc.invoke).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('credential.helper osxkeychain')
    expect(document.body.textContent).toContain('ssh-agent')
    expect(document.querySelector('input')).toBeNull()
  })
})
