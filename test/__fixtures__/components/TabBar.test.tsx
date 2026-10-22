// @vitest-environment jsdom

import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ isTauri: false }))
const invokeMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined))
const gitState = vi.hoisted(() => ({ current: { isRepo: false, hasRemote: false, ahead: 0, upstream: '', status: '', repoState: 'clean' as string } }))
const editorState = vi.hoisted(() => ({
  activeTab: 'notes/active-document-with-a-long-name.md' as string | null,
  tabs: [
    { path: 'notes/first.md', name: 'first.md', content: '', frontmatter: '', editedContent: null, dirty: false, deleted: false },
    { path: 'notes/active-document-with-a-long-name.md', name: 'active-document-with-a-long-name.md', content: '', frontmatter: '', editedContent: null, dirty: false, deleted: false },
    { path: 'notes/last.md', name: 'last.md', content: '', frontmatter: '', editedContent: null, dirty: false, deleted: false },
  ],
  editMode: 'editor',
  canUndo: false,
  canRedo: false,
  undo: vi.fn(),
  redo: vi.fn(),
  persistAllDirty: vi.fn(async () => {}),
  switchTab: vi.fn(),
  closeTab: vi.fn(async () => {}),
  toggleEditMode: vi.fn(),
}))

vi.mock('../../../frontend/stores/editor', () => ({
  useEditorStore: Object.assign(
    (selector?: (state: typeof editorState) => unknown) => selector ? selector(editorState) : editorState,
    { getState: () => editorState },
  ),
}))
vi.mock('../../../frontend/stores/gitStatus', () => ({
  useGitStatus: () => gitState.current,
}))
vi.mock('../../../frontend/lib/ipc', () => ({
  get isTauri() { return runtime.isTauri },
  isMacTauri: true,
  invoke: invokeMock,
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn() } }))

import { TabBar } from '../../../frontend/components/editor/TabBar'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | null

function renderTabBar(isDesktop: boolean) {
  root = createRoot(document.getElementById('root')!)
  act(() => root!.render(
    <TabBar
      sidebarOpen
      isDesktop={isDesktop}
      sidebarToggleRef={createRef<HTMLButtonElement>()}
      onToggleSidebar={() => {}}
      onOpenSearch={() => {}}
    />,
  ))
}

function renderedTabPaths() {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-tab-path]'), tab => tab.dataset.tabPath)
}


beforeEach(() => {
  runtime.isTauri = false
  invokeMock.mockImplementation(async () => undefined)
  gitState.current = { isRepo: false, hasRemote: false, ahead: 0, upstream: '', status: '', repoState: 'clean' }
  document.body.innerHTML = '<div id="root"></div>'
  vi.stubGlobal('CSS', { escape: (value: string) => value })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('responsive tabs', () => {
  it('shows only truncated active tab in compact web layout', () => {
    renderTabBar(false)

    expect(renderedTabPaths()).toEqual(['notes/active-document-with-a-long-name.md'])
    const label = document.querySelector<HTMLElement>('[title="active-document-with-a-long-name.md"]')
    const activeTab = document.querySelector<HTMLElement>('[data-tab-path]')!
    expect(label?.classList.contains('truncate')).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Close active-document-with-a-long-name.md"]')!.style.pointerEvents).toBe('auto')
    // Tab boundaries come from the strip (adjacent-sibling rule), so no tab ever
    // carries a border of its own — that is what left a dangling edge before.
    expect(document.querySelector('.tab-strip')).not.toBeNull()
    expect(activeTab.classList.contains('border-r')).toBe(false)
    expect(activeTab.className).not.toContain('shadow-[inset_0_-1px_0_var(--color-accent)]')
  })

  it('keeps every tab and shows the icon Actions trigger on desktop web', () => {
    renderTabBar(true)

    expect(renderedTabPaths()).toEqual([
      'notes/first.md',
      'notes/active-document-with-a-long-name.md',
      'notes/last.md',
    ])
    const activeTab = document.querySelector<HTMLElement>('[data-tab-path="notes/active-document-with-a-long-name.md"]')!
    expect(document.querySelector('.editor-tab-bar-track')?.hasAttribute('data-tauri-drag-region')).toBe(true)
    expect(document.querySelector('.tab-strip')?.hasAttribute('data-tauri-drag-region')).toBe(true)
    expect(document.querySelector('.tab-strip')).not.toBeNull()
    // No right edge on the last tab: the strip draws boundaries between tabs only.
    expect(document.querySelector<HTMLElement>('[data-tab-path="notes/last.md"]')!.classList.contains('border-r')).toBe(false)
    expect(activeTab.classList.contains('border-r')).toBe(false)
    expect(activeTab.className).not.toContain('shadow-[inset_0_-1px_0_var(--color-accent)]')
    // Wide layouts keep history inline; the icon trigger holds the rest.
    const actions = document.querySelector<HTMLButtonElement>('[aria-label="More actions"]')
    expect(actions).not.toBeNull()
    expect(actions!.textContent).not.toContain('Actions')
    expect(document.querySelector('[aria-label="Undo"]')).not.toBeNull()
    expect(document.querySelector('[aria-label="Redo"]')).not.toBeNull()
    act(() => actions!.click())
    expect(document.body.textContent).toContain('Switch to markdown')
    expect(document.body.textContent).not.toContain('Undo')
    expect(document.body.textContent).not.toContain('Redo')
    // External editor + Finder actions are desktop-only.
    expect(document.body.textContent).not.toContain('Open in editor')
    expect(document.body.textContent).not.toContain('Reveal in Finder')
  })

  it('keeps every tab and adds desktop-only file actions in narrow Tauri windows', async () => {
    runtime.isTauri = true
    renderTabBar(false)

    expect(renderedTabPaths()).toEqual([
      'notes/first.md',
      'notes/active-document-with-a-long-name.md',
      'notes/last.md',
    ])
    const actions = document.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!
    // Below 640px the trigger stays the compact text button, even on Tauri.
    expect(actions.textContent).toContain('Actions')
    expect(document.querySelector('[aria-label="Undo"]')).toBeNull()
    await act(async () => { actions.click() })
    expect(document.body.textContent).toContain('Undo')
    expect(document.body.textContent).toContain('Redo')
    expect(document.body.textContent).toContain('Open in editor')
    expect(document.body.textContent).toContain('Reveal in Finder')
    // In WYSIWYG the menu item shows the icon of the mode a click switches TO:
    // BsMarkdown (16px grid) — not the LuPencilRuler (24px grid) shown in source mode.
    const modeItem = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Switch to markdown')!
    expect(modeItem.querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 16 16')
    act(() => modeItem.click())
    expect(editorState.toggleEditMode).toHaveBeenCalledTimes(1)
  })

  it('flushes and opens the active file in the external editor', async () => {
    runtime.isTauri = true
    renderTabBar(true)

    act(() => document.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!.click())
    const openItem = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Open in editor')!
    await act(async () => { openItem.click() })

    expect(editorState.persistAllDirty).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith('open_in_editor', { path: 'notes/active-document-with-a-long-name.md', app: null })
  })

  it('lists detected editors and opens the chosen one', async () => {
    runtime.isTauri = true
    invokeMock.mockImplementation(async (cmd: unknown) => cmd === 'list_editors'
      ? [{ name: 'Zed', path: '/Applications/Zed.app' }]
      : undefined)
    renderTabBar(true)
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!.click() })

    // Names come from LaunchServices, not a hardcoded list.
    const openItem = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Open in Zed')!
    await act(async () => { openItem.click() })

    expect(invokeMock).toHaveBeenCalledWith('open_in_editor', { path: 'notes/active-document-with-a-long-name.md', app: '/Applications/Zed.app' })
  })

  it('uses a brand icon per editor and a generic fallback', async () => {
    runtime.isTauri = true
    invokeMock.mockImplementation(async (cmd: unknown) => cmd === 'list_editors'
      ? [
        { name: 'Zed', path: '/Applications/Zed.app' },
        { name: 'Visual Studio Code', path: '/Applications/Visual Studio Code.app' },
        { name: 'Some Editor', path: '/Applications/Some Editor.app' },
      ]
      : undefined)
    renderTabBar(true)
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!.click() })

    const iconOf = (label: string) => Array.from(document.querySelectorAll('button'))
      .find(b => b.textContent === label)!.querySelector('svg')!
    // Simple-icons/brand sets are filled; lucide is stroked.
    expect(iconOf('Open in Zed').getAttribute('fill')).toBe('currentColor')
    // VS Code's icon lives in the react-icons/vsc set (16px grid).
    expect(iconOf('Open in Visual Studio Code').getAttribute('viewBox')).toBe('0 0 16 16')
    // Unknown editors still get a row — only the icon is generic.
    expect(iconOf('Open in Some Editor').getAttribute('fill')).toBe('none')
  })

  it('reveals the active file in Finder', async () => {
    runtime.isTauri = true
    renderTabBar(true)

    act(() => document.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!.click())
    const revealItem = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Reveal in Finder')!
    await act(async () => { revealItem.click() })

    expect(invokeMock).toHaveBeenCalledWith('reveal_in_finder', { path: 'notes/active-document-with-a-long-name.md' })
  })

  it('shows editor-only Actions in compact web layout', () => {
    renderTabBar(false)

    const actions = document.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!
    expect(actions).not.toBeNull()
    // Compact keeps history + mode inside Actions only — no inline buttons.
    expect(document.querySelector('[aria-label="Switch to Markdown mode"]')).toBeNull()
    expect(document.querySelector('[aria-label="Undo"]')).toBeNull()
    act(() => actions.click())

    expect(document.body.textContent).toContain('Undo')
    expect(document.body.textContent).toContain('Redo')
    expect(document.body.textContent).toContain('Switch to markdown')
    // Compact uses the same shared mode icon as every other trigger.
    const modeItem = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Switch to markdown')!
    expect(modeItem.querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 16 16')
    expect(document.body.textContent).not.toContain('Open in editor')
    expect(document.body.textContent).not.toContain('Commit')
    expect(document.body.textContent).not.toContain('Push')
  })

  it('reveals a close button on every tab and closes the hovered inactive tab', () => {
    renderTabBar(true)

    // Every tab — not just the active one — carries its own close affordance.
    const close = document.querySelector<HTMLButtonElement>('[aria-label="Close first.md"]')
    expect(close).not.toBeNull()
    expect(document.querySelector('[aria-label="Close last.md"]')).not.toBeNull()

    act(() => close!.click())
    expect(editorState.closeTab).toHaveBeenCalledWith('notes/first.md')
    // stopPropagation: closing an inactive tab must not also switch to it.
    expect(editorState.switchTab).not.toHaveBeenCalled()
  })
})
