// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { settle } from '../harness'

/** Wiring under test: opening the Changes tab must re-probe git status, because
 *  the shared store otherwise only refreshes on git actions, window focus, and
 *  vault open/close. */
const ipc = vi.hoisted(() => ({ invoke: vi.fn(async (..._args: unknown[]) => undefined) }))
const git = vi.hoisted(() => ({
  state: { isRepo: true, hasRemote: false, branch: 'main', upstream: '', status: '', ahead: 0, behind: 0, pushTarget: '', hasCommits: true, remotes: [], repoState: 'clean' },
  poll: vi.fn(async (..._args: unknown[]) => {}),
}))
const vaultState = vi.hoisted(() => ({
  name: 'vault',
  isOpen: true,
  vaultPath: '/vault',
  recent: [],
  loading: false,
  visibleItems: [] as unknown[],
  openVault: vi.fn(async () => {}),
  openRecent: vi.fn(async () => {}),
  toggleFolder: vi.fn(),
  loadTree: vi.fn(async () => {}),
}))
const editorState = vi.hoisted(() => ({
  activeTab: null as string | null,
  openFile: vi.fn(async () => {}),
  flushEditor: vi.fn(async () => {}),
  renameTab: vi.fn(async () => {}),
  setTabDeleted: vi.fn(),
}))

vi.mock('sonner', () => ({ Toaster: () => null, toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }))
vi.mock('../../../frontend/lib/ipc', () => ({
  invoke: (...args: unknown[]) => ipc.invoke(...args),
  isTauri: false,
  isMacTauri: false,
  trashPermissionError: () => null,
  openSystemSettings: vi.fn(async () => true),
}))
vi.mock('../../../frontend/stores/vault', () => ({
  useVaultStore: Object.assign(() => vaultState, { getState: () => vaultState }),
}))
vi.mock('../../../frontend/stores/editor', () => ({
  useEditorStore: Object.assign(
    (selector?: (state: typeof editorState) => unknown) => (selector ? selector(editorState) : editorState),
    { getState: () => editorState },
  ),
}))
vi.mock('../../../frontend/stores/gitStatus', () => ({
  useGitStatus: Object.assign(
    (selector?: (value: typeof git.state) => unknown) => (selector ? selector(git.state) : git.state),
    { getState: () => git.state },
  ),
  pollGitStatus: (...args: unknown[]) => git.poll(...args),
}))
vi.mock('../../../frontend/components/panels/GitPanel', () => ({ default: () => null }))

import Sidebar from '../../../frontend/components/Sidebar'

let root: Root | null
const panelTab = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="sidebar-panel-${id}"]`)!

async function renderSidebar() {
  root = createRoot(document.getElementById('root')!)
  act(() => root!.render(
    <Sidebar
      id="sidebar"
      onOpenSettings={() => {}}
      onOpenSearch={() => {}}
      onOpenShortcuts={() => {}}
      onRequestCloseVault={() => {}}
      registerSearchFolder={() => () => {}}
    />,
  ))
  await settle()
}

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
})
afterEach(() => { if (root) act(() => root!.unmount()); root = null; vi.clearAllMocks() })

describe('Sidebar Changes tab refresh', () => {
  it('re-probes git status, forced, when the Changes tab is opened', async () => {
    await renderSidebar()
    git.poll.mockClear()

    act(() => panelTab('git').click())
    await settle()

    // Forced: a vault first probed as a non-repo must be re-checked, so a
    // terminal `git init` shows up without waiting for the next focus event.
    expect(git.poll).toHaveBeenCalledWith(true)
  })

  it('does not touch git status when returning to the Folders tab', async () => {
    await renderSidebar()
    act(() => panelTab('git').click())
    await settle()
    git.poll.mockClear()

    act(() => panelTab('vault').click())
    await settle()

    expect(git.poll).not.toHaveBeenCalled()
  })
})
