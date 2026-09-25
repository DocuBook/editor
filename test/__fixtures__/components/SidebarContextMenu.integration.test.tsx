// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { flush, tick } from '../harness'

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

/** Any tree row by its label — the folder/file rows own the contextmenu handler.
 *  Folders render their bare name; files the extension-stripped one. */
const row = (label: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('span.truncate')).find(node => node.textContent === label)!.parentElement as HTMLElement

const inlineInput = () => document.querySelector<HTMLInputElement>('input[type="text"]')!

/** React's value tracker swallows a plain `.value` write, so the change has to
 *  come through the native setter to reach `onChange`. */
const typeInto = (el: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const pressEnter = (el: HTMLInputElement) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

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
const openMenuOn = (label: string) => act(() => row(label).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 120 })))
const openMenu = () => openMenuOn('active')
const clickOutside = () => act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))

beforeEach(() => {
  vaultState.visibleItems = [{ path: 'notes/active.md', name: 'active.md', type: '0', depth: 0 }]
  document.body.innerHTML = '<div id="root"></div>'
})
afterEach(() => { if (root) act(() => root!.unmount()); root = null; vi.clearAllMocks() })

describe('SidebarContextMenu in the Sidebar', () => {
  /** The mobile sidebar drawer transforms its content, which would make the
   *  drawer the containing block of the `fixed` menu and confine it to the
   *  drawer box — so the menu is portaled to document.body instead. */
  it('renders at the pointer position, outside the sidebar', async () => {
    renderSidebar()
    await flush()

    openMenu()

    expect(menu()).not.toBeNull()
    expect(menu()!.closest('#root')).toBeNull()
    expect(menu()!.closest('#sidebar')).toBeNull()
    expect(menu()!.style.top).toBe('120px')
    expect(menu()!.style.left).toBe('40px')
    expect(menu()!.textContent).toContain('New File')
    expect(menu()!.textContent).toContain('New Folder')
    expect(menu()!.textContent).toContain('Rename')
    expect(menu()!.textContent).toContain('Delete')
  })

  /** Leaving the drawer's trap also left its tabbable set, so the menu has to
   *  claim focus itself — otherwise nothing but a mouse can reach its actions.
   *  It claims the menu, not its first action: a right-click must not pre-seat
   *  "New File" for whatever Enter comes next. The arrow walk that makes this
   *  focus useful is covered in SidebarContextMenu.test.tsx. */
  it('takes focus itself without pre-seating an action', async () => {
    renderSidebar()
    await flush()
    openMenu()

    await tick()

    expect(document.activeElement).toBe(menu())
  })

  it('closes on a click outside the portaled menu', async () => {
    renderSidebar()
    await flush()
    openMenu()

    clickOutside()

    expect(menu()).toBeNull()
  })

  /** The dismissal listens on window mousedown, so a press that starts inside the
   *  menu has to survive it. */
  it('stays open while the pointer is inside it', async () => {
    renderSidebar()
    await flush()
    openMenu()

    act(() => menu()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))

    expect(menu()).not.toBeNull()
  })

  it('closes the menu and pre-fills the input with the clicked row when Rename is picked', async () => {
    renderSidebar()
    await flush()
    openMenu()

    act(() => menuButton('Rename')!.click())

    expect(menu()).toBeNull()
    expect(inlineInput().defaultValue).toBe('active')
  })

  /** The tree entry and its open tab both carry the old path, so the editor is
   *  flushed and remapped before the reload — a dirty buffer saved after the move
   *  would resurrect the file at the path it was renamed away from. */
  it('renames the row on Enter from its original path and remaps its open tab', async () => {
    vaultState.visibleItems = [{ path: 'notes', name: 'notes', type: '1', depth: 0 }]
    renderSidebar()
    await flush()
    openMenuOn('notes')

    act(() => menuButton('Rename')!.click())
    expect(inlineInput().defaultValue).toBe('notes')

    act(() => typeInto(inlineInput(), 'archive'))
    act(() => pressEnter(inlineInput()))
    await flush()

    expect(editorState.flushEditor).toHaveBeenCalled()
    expect(ipc.invoke).toHaveBeenCalledWith('rename_file', { from: 'notes', to: 'archive' })
    expect(editorState.renameTab).toHaveBeenCalledWith('notes', 'archive')
    expect(document.querySelector('input[type="text"]')).toBeNull()
  })

  /** The rename input is uncontrolled, so a second Rename on another row has to
   *  remount it: reusing the node would keep the text typed for the first row and
   *  submit it as the second row's new name. */
  it('pre-fills a second Rename with the new row\'s name, not the previous row\'s typed text', async () => {
    vaultState.visibleItems = [
      { path: 'notes/active.md', name: 'active.md', type: '0', depth: 0 },
      { path: 'notes', name: 'notes', type: '1', depth: 0 },
    ]
    renderSidebar()
    await flush()

    openMenu()
    act(() => menuButton('Rename')!.click())
    act(() => typeInto(inlineInput(), 'discarded'))
    expect(inlineInput().value).toBe('discarded')

    openMenuOn('notes')
    act(() => menuButton('Rename')!.click())

    expect(inlineInput().defaultValue).toBe('notes')
    expect(inlineInput().value).toBe('notes')
  })

  /** A file row targets its own directory, so the new note lands beside it rather
   *  than at whatever folder the tree happened to be pointed at. */
  it('creates the new file in the right-clicked file\'s folder', async () => {
    renderSidebar()
    await flush()
    openMenu()

    act(() => menuButton('New File')!.click())

    expect(menu()).toBeNull()
    expect(inlineInput().placeholder).toBe('File in notes/')
    expect(vaultState.toggleFolder).not.toHaveBeenCalled()

    act(() => typeInto(inlineInput(), 'launch'))
    act(() => pressEnter(inlineInput()))
    await flush()

    expect(ipc.invoke).toHaveBeenCalledWith('create_file', { path: 'notes/launch.md' })
  })

  /** A folder row targets that folder, and expanding it is what keeps the new
   *  child visible once `handleCreate` reloads the tree. */
  it('creates the new folder inside the right-clicked folder, expanding it', async () => {
    vaultState.visibleItems = [{ path: 'notes', name: 'notes', type: '1', depth: 0 }]
    renderSidebar()
    await flush()
    openMenuOn('notes')

    act(() => menuButton('New Folder')!.click())

    expect(menu()).toBeNull()
    expect(vaultState.toggleFolder).toHaveBeenCalledWith(expect.objectContaining({ path: 'notes' }))
    expect(inlineInput().placeholder).toBe('Folder in notes/')

    act(() => typeInto(inlineInput(), 'drafts'))
    act(() => pressEnter(inlineInput()))
    await flush()

    expect(ipc.invoke).toHaveBeenCalledWith('create_directory', { path: 'notes/drafts' })
  })
})
