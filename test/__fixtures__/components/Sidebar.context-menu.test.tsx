// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { flush } from '../harness'

const ipc = vi.hoisted(() => ({ invoke: vi.fn(async () => '[]') }))
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

vi.mock('../../../frontend/lib/ipc', () => ({
  invoke: ipc.invoke,
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
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('../../../frontend/components/panels/GitPanel', () => ({ default: () => null }))

import Sidebar from '../../../frontend/components/Sidebar'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | null

const menu = () => document.querySelector<HTMLElement>('[data-ctx-menu]')
const menuButton = (label: string) =>
  Array.from(menu()?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(node => node.textContent === label)

/** The vault row for `active.md`; the folder/file rows own the contextmenu handler. */
const fileRow = () =>
  Array.from(document.querySelectorAll<HTMLElement>('span.truncate')).find(node => node.textContent === 'active')!.parentElement as HTMLElement

function renderSidebar() {
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
}

/** Right-click as the pointer reports it: viewport coordinates, none of them zero. */
const openMenu = () => act(() => fileRow().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 120 })))
const clickOutside = () => act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))

beforeEach(() => { document.body.innerHTML = '<div id="root"></div>' })
afterEach(() => { if (root) act(() => root!.unmount()); root = null; vi.clearAllMocks() })

describe('Sidebar context menu', () => {
  /** The mobile sidebar drawer transforms its content, which would make the
   *  drawer the containing block of the `fixed` menu and confine it to the
   *  drawer box — so the menu is portaled to document.body instead. */
  it('renders at the pointer position, outside the sidebar', async () => {
    renderSidebar()
    await flush()

    openMenu()

    expect(menu()).not.toBeNull()
    expect(menu()!.parentElement).toBe(document.body)
    expect(menu()!.closest('#sidebar')).toBeNull()
    expect(menu()!.style.top).toBe('120px')
    expect(menu()!.style.left).toBe('40px')
    expect(menu()!.textContent).toContain('Rename')
    expect(menu()!.textContent).toContain('Delete')
  })

  it('closes on a click outside the portaled menu', async () => {
    renderSidebar()
    await flush()
    openMenu()

    clickOutside()

    expect(menu()).toBeNull()
  })

  it('stays open while the pointer is inside it and starts a rename', async () => {
    renderSidebar()
    await flush()
    openMenu()

    act(() => menu()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(menu()).not.toBeNull()

    act(() => menuButton('Rename')!.click())

    expect(menu()).toBeNull()
    expect(document.querySelector<HTMLInputElement>('input[type="text"]')!.defaultValue).toBe('active')
  })
})
