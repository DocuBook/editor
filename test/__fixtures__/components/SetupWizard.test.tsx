// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { settle } from '../harness'

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('../../../frontend/lib/ipc', () => ({ invoke: ipc.invoke }))

import SetupWizard from '../../../frontend/components/SetupWizard'

let root: Root
const status = (body: object) => ipc.invoke.mockImplementation(async (cmd: string) =>
  cmd === 'setup_status' ? JSON.stringify(body) : undefined)

const render = async () => {
  root = createRoot(document.getElementById('root')!)
  act(() => root.render(<SetupWizard />))
  await settle()
}

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
})

afterEach(() => {
  act(() => root?.unmount())
  vi.clearAllMocks()
})

describe('SetupWizard token hint', () => {
  it('shows a callout with the log command when the server printed a one-time token', async () => {
    status({ setupRequired: true, setupToken: true, setupTokenSource: 'log' })
    await render()
    const note = document.querySelector('#setup-token-hint')
    expect(note?.getAttribute('role')).toBe('note')
    expect(note?.textContent).toContain('One-time token from the server log')
    expect(note?.querySelector('code')?.textContent).toContain('docker logs')
    expect(document.querySelector('input[placeholder="Setup token"]')).not.toBeNull()
  })

  it('shows the env callout when DB_SETUP_TOKEN is set', async () => {
    status({ setupRequired: true, setupToken: true, setupTokenSource: 'env' })
    await render()
    expect(document.querySelector('#setup-token-hint')?.textContent).toContain('Set by DB_SETUP_TOKEN')
    expect(document.querySelector('#setup-token-hint code')).toBeNull()
  })

  it('hides the token field and the callout when no token is required', async () => {
    status({ setupRequired: true, setupToken: false, setupTokenSource: null })
    await render()
    expect(document.querySelector('input[placeholder="Setup token"]')).toBeNull()
    expect(document.querySelector('#setup-token-hint')).toBeNull()
  })
})
