// @vitest-environment jsdom

import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ isTauri: false }))
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
  isMacTauri: false,
  invoke: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn() } }))

import { TabBar } from '../../../frontend/components/editor/TabBar'
import { invoke } from '../../../frontend/lib/ipc'

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

/** The Actions dropdown renders the Commit entry only once opened. Its disabled
 *  state encodes the porcelain-derived disk-dirty flag for the ACTIVE file. */
function commitButton() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find(button => button.textContent?.trim() === 'Commit')
}

function openActions() {
  const actions = document.querySelector<HTMLButtonElement>('button[aria-label="Git actions"]')!
  act(() => actions.click())
}

beforeEach(() => {
  runtime.isTauri = false
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

/** Porcelain `XY path` lines from the git poller: X = index, Y = worktree, '.'
 *  = unchanged. Only a worktree change (Y !== '.') on the ACTIVE file unlocks
 *  Commit — a staged-only edit (Y === '.') must not. */
describe('commit gating from porcelain status', () => {
  const stagedOnly = 'M. notes/active-document-with-a-long-name.md'
  const unstaged = '.M notes/active-document-with-a-long-name.md'

  it('leaves Commit disabled for a staged-only active file', () => {
    gitState.current = { isRepo: true, hasRemote: false, ahead: 0, upstream: '', status: stagedOnly, repoState: 'clean' }
    renderTabBar(true)
    openActions()

    expect(commitButton()?.disabled).toBe(true)
  })

  it('enables Commit for an unstaged active file', () => {
    gitState.current = { isRepo: true, hasRemote: false, ahead: 0, upstream: '', status: unstaged, repoState: 'clean' }
    renderTabBar(true)
    openActions()

    expect(commitButton()?.disabled).toBe(false)
  })

  it('ignores worktree changes on a non-active file', () => {
    gitState.current = { isRepo: true, hasRemote: false, ahead: 0, upstream: '', status: '.M notes/first.md', repoState: 'clean' }
    renderTabBar(true)
    openActions()

    expect(commitButton()?.disabled).toBe(true)
  })

  it('enables Commit during a merge even when the active tab looks clean', () => {
    gitState.current = { isRepo: true, hasRemote: false, ahead: 0, upstream: '', status: '', repoState: 'merge' }
    renderTabBar(true)
    openActions()

    expect(commitButton()?.disabled).toBe(false)
    expect(document.body.textContent).toContain('Merge in progress — Commit records the resolved working tree')
  })

  it('keeps Commit disabled while a rebase uses Continue', () => {
    gitState.current = { isRepo: true, hasRemote: false, ahead: 0, upstream: '', status: '.M notes/active-document-with-a-long-name.md', repoState: 'rebase' }
    renderTabBar(true)
    openActions()

    expect(commitButton()?.disabled).toBe(true)
    expect(document.body.textContent).not.toContain('Commit records the resolved working tree')
  })

  it('keeps Commit disabled during unsupported repository operations', () => {
    gitState.current = { isRepo: true, hasRemote: false, ahead: 0, upstream: '', status: '', repoState: 'revert' }
    renderTabBar(true)
    openActions()

    expect(commitButton()?.disabled).toBe(true)
  })

  it('enables Commit while a conflict is in the index', () => {
    gitState.current = { isRepo: true, hasRemote: false, ahead: 0, upstream: '', status: 'UU notes/other.md', repoState: 'merge' }
    renderTabBar(true)
    openActions()

    expect(commitButton()?.disabled).toBe(false)
  })

  it('still blocks Commit during a merge while the active tab is unsaved', () => {
    gitState.current = { isRepo: true, hasRemote: false, ahead: 0, upstream: '', status: '', repoState: 'merge' }
    editorState.tabs[1].dirty = true
    renderTabBar(true)
    openActions()

    expect(commitButton()?.disabled).toBe(true)
    expect(document.body.textContent).toContain('Unsaved changes')

    editorState.tabs[1].dirty = false
  })
})

/** The Commit action no longer hardcodes `Auto-commit: <file>` — it builds a
 *  conventional subject from the changed-file list (AI when configured, the
 *  deterministic fallback otherwise). */
describe('auto commit message', () => {
  it('commits with a conventional message derived from the changed files', async () => {
    const status = '.M notes/active-document-with-a-long-name.md'
    gitState.current = { isRepo: true, hasRemote: false, ahead: 0, upstream: '', status, repoState: 'clean' }
    const invokeMock = vi.mocked(invoke)
    invokeMock.mockImplementation((async (cmd: string) => {
      if (cmd === 'git_status') return JSON.stringify({ status })
      if (cmd === 'git_commit') return JSON.stringify({ success: true, commit: 'abcdef1234', message: 'Committed', error: '' })
      return undefined
    }) as typeof invoke)

    renderTabBar(true)
    openActions()
    await act(async () => { commitButton()!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    const commitCall = invokeMock.mock.calls.find(([cmd]) => cmd === 'git_commit')
    expect(commitCall).toBeTruthy()
    expect((commitCall![1] as { message: string }).message).toBe('docs(notes): update active-document-with-a-long-name.md')
  })
})
