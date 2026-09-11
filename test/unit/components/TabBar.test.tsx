// @vitest-environment jsdom

import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ isTauri: false }))
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
  useGitStatus: () => ({ isRepo: false, hasRemote: false, ahead: 0, upstream: '', status: '' }),
}))
vi.mock('../../../frontend/lib/ipc', () => ({
  get isTauri() { return runtime.isTauri },
  isMacTauri: false,
  invoke: vi.fn(),
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
    expect(document.querySelector('[data-testid="active-tab-indicator"]')).not.toBeNull()
    expect(activeTab.classList.contains('border-r')).toBe(false)
    expect(activeTab.className).not.toContain('shadow-[inset_0_-1px_0_var(--color-accent)]')
  })

  it('keeps every tab on desktop web', () => {
    renderTabBar(true)

    expect(renderedTabPaths()).toEqual([
      'notes/first.md',
      'notes/active-document-with-a-long-name.md',
      'notes/last.md',
    ])
    const activeTab = document.querySelector<HTMLElement>('[data-tab-path="notes/active-document-with-a-long-name.md"]')!
    expect(activeTab.classList.contains('border-r')).toBe(true)
    expect(activeTab.className).not.toContain('shadow-[inset_0_-1px_0_var(--color-accent)]')
    expect(document.querySelector('[data-testid="active-tab-indicator"]')).not.toBeNull()
  })

  it('keeps every tab in narrow Tauri windows', () => {
    runtime.isTauri = true
    renderTabBar(false)

    expect(renderedTabPaths()).toEqual([
      'notes/first.md',
      'notes/active-document-with-a-long-name.md',
      'notes/last.md',
    ])
    expect(document.querySelector('[data-testid="active-tab-indicator"]')).not.toBeNull()
  })
})
