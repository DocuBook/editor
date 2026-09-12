// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gitState = vi.hoisted(() => ({
  isRepo: true,
  hasRemote: true,
  branch: 'main',
  upstream: 'origin/main',
  status: '',
  ahead: 0,
  behind: 0,
}))

const editorState = vi.hoisted(() => ({ openFile: vi.fn(async () => {}) }))

vi.mock('../../../frontend/stores/gitStatus', () => ({
  useGitStatus: () => gitState,
  pollGitStatus: vi.fn(async () => {}),
}))

vi.mock('../../../frontend/stores/editor', () => ({
  useEditorStore: (selector: (state: typeof editorState) => unknown) => selector(editorState),
}))

import { pollGitStatus } from '../../../frontend/stores/gitStatus'
import GitPanel from '../../../frontend/components/panels/GitPanel'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | null

function renderPanel() {
  root = createRoot(document.getElementById('root')!)
  act(() => root!.render(<GitPanel />))
}

/** The <section> owned by a group heading such as "Changes (3)". */
function groupSection(label: 'Changes' | 'Staged'): HTMLElement | null {
  const heading = Array.from(document.querySelectorAll('div')).find(node => new RegExp(`^${label} \\(\\d+\\)$`).test(node.textContent ?? ''))
  return heading?.parentElement ?? null
}

function groupPaths(label: 'Changes' | 'Staged'): string[] {
  return Array.from(groupSection(label)?.querySelectorAll<HTMLButtonElement>('button[title]') ?? [], row => row.title)
}

const rowByPath = (path: string) => document.querySelector<HTMLButtonElement>(`button[title="${path}"]`)

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  Object.assign(gitState, { isRepo: true, hasRemote: true, branch: 'main', upstream: 'origin/main', status: '', ahead: 0, behind: 0 })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  vi.clearAllMocks()
})

describe('GitPanel', () => {
  it('reports a non-repository vault', () => {
    gitState.isRepo = false
    renderPanel()

    expect(document.body.textContent).toContain('Vault is not a git repository.')
    expect(document.body.textContent).not.toContain('Working tree is clean.')
  })

  it('reports a clean working tree', () => {
    gitState.isRepo = true
    gitState.status = ''
    renderPanel()

    expect(document.body.textContent).toContain('Working tree is clean.')
    expect(document.body.textContent).not.toContain('Vault is not a git repository.')
    expect(groupSection('Changes')).toBeNull()
    expect(groupSection('Staged')).toBeNull()
  })

  it('splits porcelain dot status into unstaged and staged changes', () => {
    gitState.status = [
      '.M notes/modified.md',
      'M. notes/staged.md',
      '?? notes/untracked.md',
      'MM notes/both.md',
    ].join('\n')
    renderPanel()

    expect(groupPaths('Changes')).toEqual(['notes/modified.md', 'notes/untracked.md', 'notes/both.md'])
    expect(groupPaths('Staged')).toEqual(['notes/staged.md', 'notes/both.md'])
    expect(groupSection('Changes')!.textContent).toContain('Changes (3)')
    expect(groupSection('Staged')!.textContent).toContain('Staged (2)')
  })

  it('marks staged rows as success and unstaged rows as warning', () => {
    gitState.status = ['.M notes/modified.md', 'M. notes/staged.md'].join('\n')
    renderPanel()

    const stagedMarker = groupSection('Staged')!.querySelector<HTMLElement>('span.font-mono')!
    const changesMarker = groupSection('Changes')!.querySelector<HTMLElement>('span.font-mono')!
    expect(stagedMarker.className).toContain('bg-success-surface')
    expect(stagedMarker.className).not.toContain('bg-warning-surface')
    expect(changesMarker.className).toContain('bg-warning-surface')
    expect(changesMarker.className).not.toContain('bg-success-surface')
  })

  it('labels untracked files as U', () => {
    gitState.status = '?? notes/untracked.md'
    renderPanel()

    expect(rowByPath('notes/untracked.md')!.querySelector('span.font-mono')!.textContent).toBe('U')
    expect(groupSection('Staged')).toBeNull()
  })

  it('opens a nested file with its basename', () => {
    gitState.status = '.M notes/sub/deep.md'
    renderPanel()

    const row = rowByPath('notes/sub/deep.md')!
    expect(row.textContent).toContain('deep.md')
    expect(row.textContent).toContain('notes/sub')

    act(() => row.click())
    expect(editorState.openFile).toHaveBeenCalledWith('notes/sub/deep.md', 'deep.md')
  })

  it('polls git status on refresh', () => {
    renderPanel()

    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Refresh git changes"]')!.click())
    expect(pollGitStatus).toHaveBeenCalledTimes(1)
  })

  it('shows branch, ahead and behind', () => {
    gitState.branch = 'feature/x'
    gitState.ahead = 2
    gitState.behind = 1
    renderPanel()

    expect(document.body.textContent).toContain('feature/x')
    expect(document.body.textContent).toContain('↑2')
    expect(document.body.textContent).toContain('↓1')
  })

  it('hides ahead/behind counters when zeroed and falls back to "no branch"', () => {
    gitState.branch = ''
    gitState.ahead = 0
    gitState.behind = 0
    renderPanel()

    expect(document.body.textContent).toContain('no branch')
    expect(document.body.textContent).not.toContain('↑')
    expect(document.body.textContent).not.toContain('↓')
  })
})
