// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
const pollGitStatus = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('../../../frontend/lib/ipc', () => ({ invoke }))
vi.mock('../../../frontend/stores/gitStatus', () => ({ pollGitStatus }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn() } }))

import GitSettings from '../../../frontend/components/GitSettings'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | null

/** Resolve the async `load()` / handler promise chains inside act. */
const flush = () => act(async () => { await Promise.resolve() })

const REPO_SETTINGS = {
  isRepo: true, noVault: false, name: 'Doc', email: 'doc@example.com', defaultBranch: 'main',
  remotes: [{ name: 'origin', url: 'https://example.com/user/repo.git' }],
}

function render() {
  root = createRoot(document.getElementById('root')!)
  act(() => root!.render(<GitSettings />))
}

const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')
const buttonByLabel = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const buttonByText = (scope: HTMLElement, text: string) =>
  Array.from(scope.querySelectorAll('button')).find(node => node.textContent?.trim() === text)

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  invoke.mockReset()
  pollGitStatus.mockClear()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
})

describe('GitSettings — remote removal', () => {
  it('asks for confirmation instead of removing on the first click', async () => {
    invoke.mockResolvedValue(JSON.stringify(REPO_SETTINGS))
    render()
    await flush()

    act(() => buttonByLabel('Remove origin')!.click())

    expect(dialog()).not.toBeNull()
    expect(dialog()!.textContent).toContain('hosted repository and its history are not deleted')
    expect(invoke).not.toHaveBeenCalledWith('git_remove_remote', expect.anything())
  })

  it('removes the remote and refreshes the shared status only after confirming', async () => {
    invoke.mockResolvedValue(JSON.stringify(REPO_SETTINGS))
    render()
    await flush()

    act(() => buttonByLabel('Remove origin')!.click())
    act(() => buttonByText(dialog()!, 'Remove')!.click())
    await flush()

    expect(invoke).toHaveBeenCalledWith('git_remove_remote', { name: 'origin' })
    expect(pollGitStatus).toHaveBeenCalled()
  })

  it('cancels without touching the remote', async () => {
    invoke.mockResolvedValue(JSON.stringify(REPO_SETTINGS))
    render()
    await flush()

    act(() => buttonByLabel('Remove origin')!.click())
    act(() => buttonByText(dialog()!, 'Cancel')!.click())

    expect(dialog()).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('git_remove_remote', expect.anything())
  })

  it('dismisses the removal confirmation with Escape', async () => {
    invoke.mockResolvedValue(JSON.stringify(REPO_SETTINGS))
    render()
    await flush()

    act(() => buttonByLabel('Remove origin')!.click())
    act(() => dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))

    expect(dialog()).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('git_remove_remote', expect.anything())
  })

  it('ignores other keys while the removal confirmation is open', async () => {
    invoke.mockResolvedValue(JSON.stringify(REPO_SETTINGS))
    render()
    await flush()

    act(() => buttonByLabel('Remove origin')!.click())
    act(() => dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))

    expect(dialog()).not.toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('git_remove_remote', expect.anything())
  })
})

describe('GitSettings — remote probe', () => {
  const probeInvoke = (probe: unknown) => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'git_settings') return JSON.stringify(REPO_SETTINGS)
      if (cmd === 'git_remote_probe') return JSON.stringify(probe)
      return undefined
    })
  }

  it('reports an unreachable remote inline instead of as a settings error', async () => {
    probeInvoke({ reachable: false, empty: false, defaultBranch: '', branches: 0, error: 'Authentication failed' })
    render()
    await flush()

    act(() => buttonByLabel('Check origin')!.click())
    await flush()

    expect(invoke).toHaveBeenCalledWith('git_remote_probe', { name: 'origin' })
    expect(document.body.textContent).toContain('Unreachable — Authentication failed')
    /** Not duplicated in the shared error slot at the foot of the form. */
    expect(document.body.textContent).not.toContain('Unreachable — Authentication failedAuthentication')
    expect(document.querySelector('.text-danger')?.textContent).not.toBe('Authentication failed')
  })

  it('keeps a thrown probe failure inline and usable', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'git_settings') return JSON.stringify(REPO_SETTINGS)
      if (cmd === 'git_remote_probe') throw new Error('network down')
      return undefined
    })
    render()
    await flush()

    act(() => buttonByLabel('Check origin')!.click())
    await flush()

    expect(document.body.textContent).toContain('Unreachable — Error: network down')
    expect(document.body.textContent).not.toContain('network downError')
  })

  it('reports a reachable remote inline', async () => {
    probeInvoke({ reachable: true, empty: false, defaultBranch: 'main', branches: 3, error: '' })
    render()
    await flush()

    act(() => buttonByLabel('Check origin')!.click())
    await flush()

    expect(document.body.textContent).toContain('Reachable — 3 branch(es), default main.')
  })
})

describe('GitSettings — init', () => {
  it('sends the selected initial branch instead of forcing master', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'git_settings') return JSON.stringify({ isRepo: false, noVault: false, name: '', email: '', defaultBranch: 'trunk', remotes: [] })
      if (cmd === 'git_init') return JSON.stringify({ created: true, branch: 'trunk' })
      return undefined
    })
    render()
    await flush()

    expect(document.body.textContent).toContain('Default branch')
    expect(document.body.textContent).toContain('never re-initialized')

    act(() => buttonByText(document.body, 'Initialize git repository')!.click())
    await flush()

    expect(invoke).toHaveBeenCalledWith('git_init', { branch: 'trunk' })
    expect(pollGitStatus).toHaveBeenCalled()
  })
})
