// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { settle } from '../harness'

/** The four ways a trash batch can end all share one rule: exactly ONE toast
 *  fires. These spies record which of them (if any) spoke. */
const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  /** What `trashPermissionError` reports: null is a plain failure, a descriptor
   *  means the macOS grant is missing (which must become a dialog, not a toast). */
  permission: null as null | { pane: 'accessibility'; message: string },
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

vi.mock('sonner', () => ({ Toaster: () => null, toast }))
vi.mock('../../../frontend/lib/ipc', () => ({
  invoke: (...args: unknown[]) => ipc.invoke(...args),
  isTauri: false,
  isMacTauri: false,
  trashPermissionError: () => ipc.permission,
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
vi.mock('../../../frontend/stores/gitStatus', () => {
  const state = { isRepo: false, hasRemote: false, branch: '', hasCommits: false, ahead: 0, behind: 0, status: '', repoState: 'clean', remotes: [], pushTarget: '', upstream: '' }
  return {
    useGitStatus: Object.assign(
      (selector?: (value: typeof state) => unknown) => (selector ? selector(state) : state),
      { getState: () => state },
    ),
    pollGitStatus: vi.fn(async () => {}),
  }
})
vi.mock('../../../frontend/components/panels/GitPanel', () => ({ default: () => null }))

import Sidebar from '../../../frontend/components/Sidebar'
import type { TrashItem } from '../../../frontend/components/panels/TrashPanel'

const fileItem: TrashItem = { name: 'file-1.md', original: 'notes/file-1.md', deleted_at: Date.parse('2026-01-02T00:00:00Z'), is_dir: false }
const folderItem: TrashItem = { name: 'folder-1', original: 'notes/folder-1', deleted_at: Date.parse('2026-02-03T00:00:00Z'), is_dir: true }

/** What the mocked backend does for the next batch. Flipped per test. */
let scenario: { items: TrashItem[]; trashRefreshFails: boolean; treeRefreshFails: boolean; failRestoreFor: string | null }

let root: Root | null
const trashTab = () => document.querySelector<HTMLButtonElement>('[data-testid="trash-toggle"]')!
const textButton = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === text)!
const checkbox = (name: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!
const toastCount = () => toast.success.mock.calls.length + toast.warning.mock.calls.length + toast.error.mock.calls.length

/** Render, let the mount-time trash fetch land (which enables the tab), then
 *  switch to the Trash panel and let its own reload settle. */
async function openTrash() {
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
  act(() => trashTab().click())
  await settle()
}

/** Select every row and run Put back, the batch entry point TrashPanel exposes. */
async function putBackAll() {
  act(() => checkbox('Select all trash items').click())
  await act(async () => textButton('Put back').click())
  await settle()
}

beforeEach(() => {
  scenario = { items: [fileItem], trashRefreshFails: false, treeRefreshFails: false, failRestoreFor: null }
  ipc.permission = null
  ipc.invoke.mockImplementation(async (command: string, args?: { trashName?: string }) => {
    switch (command) {
      case 'list_trash':
        if (scenario.trashRefreshFails) throw new Error('trash unavailable')
        return JSON.stringify(scenario.items)
      case 'restore_file':
        if (scenario.failRestoreFor === args?.trashName) throw new Error('restore blocked')
        return undefined
      default:
        return undefined
    }
  })
  vaultState.loadTree.mockReset()
  vaultState.loadTree.mockImplementation(async () => { if (scenario.treeRefreshFails) throw new Error('tree gone') })
  vaultState.visibleItems = []
  document.body.innerHTML = '<div id="root"></div>'
})
afterEach(() => { if (root) act(() => root!.unmount()); root = null; vi.clearAllMocks() })

describe('Sidebar trash toasts', () => {
  it('confirms a clean batch with a single success toast', async () => {
    await openTrash()

    expect(trashTab().disabled).toBe(false)
    await putBackAll()

    expect(toast.success).toHaveBeenCalledWith('1 item restored')
    expect(toastCount()).toBe(1)
  })

  /** The regression: a green "restored" used to land beside a red "could not
   *  refresh", reading as a contradiction. One stale view now folds into one
   *  warning. */
  it('folds a failed Trash refresh into one warning, never a success beside an error', async () => {
    await openTrash()
    scenario.trashRefreshFails = true
    await putBackAll()

    expect(toast.warning).toHaveBeenCalledTimes(1)
    const message = toast.warning.mock.calls[0][0] as string
    expect(message).toContain('1 item restored')
    expect(message).toContain('could not refresh the Trash view')
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(toastCount()).toBe(1)
  })

  it('names both stale views when the vault refresh fails too', async () => {
    await openTrash()
    scenario.trashRefreshFails = true
    scenario.treeRefreshFails = true
    await putBackAll()

    expect(toast.warning).toHaveBeenCalledTimes(1)
    expect(toast.warning.mock.calls[0][0] as string).toContain('Trash view and vault view')
    expect(toastCount()).toBe(1)
  })

  it('reports a partial failure and a stale panel in one error toast', async () => {
    scenario.items = [fileItem, folderItem]
    scenario.failRestoreFor = folderItem.name
    await openTrash()
    scenario.trashRefreshFails = true
    await putBackAll()

    expect(toast.error).toHaveBeenCalledTimes(1)
    const message = toast.error.mock.calls[0][0] as string
    expect(message).toContain('1 item restored, but 1 failed')
    expect(message).toContain('Trash view could not be refreshed')
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
    expect(toastCount()).toBe(1)
  })

  /** A missing macOS grant is actionable, so it opens the deep-linking dialog
   *  instead of a toast that would only say "something is wrong". */
  it('raises the permission dialog with no toast when the grant is missing', async () => {
    ipc.permission = { pane: 'accessibility', message: 'Put Back needs Accessibility access to move items out of the Trash.' }
    scenario.failRestoreFor = fileItem.name
    await openTrash()
    await putBackAll()

    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"][aria-label="Permission required"]')
    expect(dialog).not.toBeNull()
    expect(dialog!.textContent).toContain('Put Back needs Accessibility access')
    expect(toastCount()).toBe(0)
  })
})
