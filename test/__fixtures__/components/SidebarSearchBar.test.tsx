// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { settle } from '../harness'

/** The search bar is scoped to the FOLDER TAB: it is the only panel that
 *  navigates files, so Changes and Trash must not keep a bar they cannot use.
 *  ⌘F/⌘P still open the modal from any panel — that lives in App. */
const ipc = vi.hoisted(() => ({ invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>) => '[]') }))
const vaultState = vi.hoisted(() => ({
  name: 'vault',
  isOpen: true,
  vaultPath: '/vault',
  recent: [],
  loading: false,
  visibleItems: [{ path: 'notes/active.md', name: 'active.md', type: '0', depth: 0 }],
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

vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }))
vi.mock('../../../frontend/lib/ipc', () => ({
  invoke: (...args: [string, Record<string, unknown>?]) => ipc.invoke(...args),
  isTauri: false,
  isMacTauri: false,
  trashPermissionError: () => null,
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
// NOTE: the real settings store is used, NOT a mock — this file drives the
// Settings-open flag, which has to notify subscribers for the sidebar to
// re-render. Seeding the real store is what makes that observable.

import Sidebar from '../../../frontend/components/Sidebar'
import { useSettings } from '../../../frontend/stores/settings'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | null
const panelTab = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="sidebar-panel-${id}"]`)!
const trashTab = () => document.querySelector<HTMLButtonElement>('[data-testid="trash-toggle"]')!
const searchBar = () => document.querySelector<HTMLButtonElement>('[aria-label="Search project files"]')

async function renderSidebar(onOpenSearch = vi.fn()) {
  root = createRoot(document.getElementById('root')!)
  act(() => root!.render(
    <Sidebar
      id="sidebar"
      onOpenSettings={() => {}}
      onOpenSearch={onOpenSearch}
      onOpenShortcuts={() => {}}

      onRequestCloseVault={() => {}}
      registerSearchFolder={() => () => {}}
    />,
  ))
  await settle()
  return onOpenSearch
}

beforeEach(() => {
  vaultState.isOpen = true
  useSettings.setState({ open: false, section: 'general-themes' })
  document.body.innerHTML = '<div id="root"></div>'
  ipc.invoke.mockClear()
})
afterEach(() => { if (root) act(() => root!.unmount()); root = null; vi.clearAllMocks() })

describe('Sidebar search bar scoping', () => {
  it('shows the bar on the Folders tab', async () => {
    await renderSidebar()

    expect(searchBar()).not.toBeNull()
    expect(searchBar()!.textContent).toContain('Search')
  })

  it('opens the App-level modal from the Folders tab', async () => {
    const onOpenSearch = await renderSidebar()

    act(() => searchBar()!.click())

    expect(onOpenSearch).toHaveBeenCalledTimes(1)
  })

  it('hides the bar on the Changes tab', async () => {
    await renderSidebar()

    act(() => panelTab('git').click())
    await settle()

    expect(searchBar()).toBeNull()
  })

  it('hides the bar on the Trash tab', async () => {
    // The trash has to be non-empty for the panel to have content; the tab itself
    // is now always enabled, so this only keeps the scenario realistic.
    ipc.invoke.mockImplementation(async (command: string) => command === 'list_trash' ? JSON.stringify([{ name: 'gone.md', deletedAt: '2026-10-01T00:00:00Z' }]) : '[]')
    await renderSidebar()
    expect(trashTab().disabled).toBe(false)

    act(() => trashTab().click())
    await settle()

    expect(searchBar()).toBeNull()
  })

  /** Scoped, not removed: returning to Folders brings it back. */
  it('restores the bar when returning to the Folders tab', async () => {
    await renderSidebar()
    act(() => panelTab('git').click())
    await settle()

    act(() => panelTab('vault').click())
    await settle()

    expect(searchBar()).not.toBeNull()
  })

  /** Settings takes over the whole sidebar column (its nav list replaces the file
   *  tree), so the bar leaves with it instead of floating above a tree it no longer
   *  searches. Settings is not a panel tab: `activePanel` stays 'vault' throughout,
   *  so the status flag is what has to be driven here. */
  it('hides the bar while Settings is open', async () => {
    await renderSidebar()
    expect(searchBar()).not.toBeNull()

    act(() => useSettings.setState({ open: true }))
    await settle()

    expect(searchBar()).toBeNull()
    expect(document.querySelector('[data-testid="settings-nav"]')).not.toBeNull()
  })

  /** Closing Settings lands back on the Folders tab, which still owns the bar —
   *  it is hidden, never unmounted out of the panel's state. */
  it('restores the bar when Settings closes', async () => {
    await renderSidebar()
    act(() => useSettings.setState({ open: true }))
    await settle()

    act(() => useSettings.setState({ open: false }))
    await settle()

    expect(searchBar()).not.toBeNull()
  })
})
