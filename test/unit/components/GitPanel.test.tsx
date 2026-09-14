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
  pushTarget: 'origin',
  hasCommits: true,
  remotes: ['origin'],
  repoState: 'clean',
}))

const editorState = vi.hoisted(() => ({ openFile: vi.fn(async () => {}) }))
const vaultTree = vi.hoisted(() => ({ loadTree: vi.fn(async () => {}) }))
const invoke = vi.hoisted(() => vi.fn(async () => ''))

vi.mock('../../../frontend/lib/ipc', () => ({ invoke }))

vi.mock('../../../frontend/stores/gitStatus', () => ({
  useGitStatus: () => gitState,
  pollGitStatus: vi.fn(async () => {}),
}))

vi.mock('../../../frontend/stores/editor', () => ({
  useEditorStore: (selector: (state: typeof editorState) => unknown) => selector(editorState),
}))

vi.mock('../../../frontend/stores/vault', () => ({
  useVaultStore: { getState: () => vaultTree },
}))

import { pollGitStatus } from '../../../frontend/stores/gitStatus'
import GitPanel from '../../../frontend/components/panels/GitPanel'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | null

function renderPanel() {
  root = createRoot(document.getElementById('root')!)
  act(() => root!.render(<GitPanel />))
}

/** The <section> owned by a group heading such as "Changes (3)". Matched on the
 *  heading alone — the section also holds rows that carry their own text. */
function groupHeading(label: 'Changes' | 'Staged' | 'Conflicts'): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('div')).find(node => new RegExp(`^${label} \\(\\d+\\)$`).test(node.textContent ?? ''))
}

function groupSection(label: 'Changes' | 'Staged' | 'Conflicts'): HTMLElement | null {
  return groupHeading(label)?.parentElement ?? null
}

/** Row paths only — the Stage action also carries a title attribute. */
function groupPaths(label: 'Changes' | 'Staged' | 'Conflicts'): string[] {
  return Array.from(groupSection(label)?.querySelectorAll<HTMLButtonElement>('button.flex[title]') ?? [], row => row.title)
}

const rowByPath = (path: string) => document.querySelector<HTMLButtonElement>(`button[title="${path}"]`)

/** The Stage action lives beside a conflict row, not inside its open-file button. */
const stageButton = (path: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="Stage ${path}"]`)

/** SyncBar buttons (Fetch/Rebase/Merge/Continue/Abort) — matched on the leading
 *  label, because an action may also carry a badge such as the incoming ↓n. */
const syncButton = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(node => node.textContent?.trim().startsWith(label))

const syncMenuButton = () => document.querySelector<HTMLButtonElement>('[aria-label="Git sync actions"]')
const openSync = () => act(() => syncMenuButton()!.click())

const confirmDialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')

const dialogButton = (label: string) =>
  Array.from(confirmDialog()?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(node => node.textContent?.trim() === label)

/** A remote-sync outcome JSON as the backend serializes it. */
const syncOutcome = (overrides: Partial<{ success: boolean; message: string; error: string; conflicts: string[] }> = {}) =>
  JSON.stringify({ success: true, message: 'Ready', error: '', conflicts: [], ...overrides })

const flush = () => act(async () => { await Promise.resolve() })

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  Object.assign(gitState, { isRepo: true, hasRemote: true, branch: 'main', upstream: 'origin/main', status: '', ahead: 0, behind: 0, pushTarget: 'origin', hasCommits: true, remotes: ['origin'], repoState: 'clean' })
  invoke.mockClear()
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

  it('keeps conflicted paths out of Changes and Staged and lists them once', () => {
    gitState.status = [
      'UU notes/conflicted.md',
      'AA notes/both-added.md',
      '.M notes/modified.md',
      'M. notes/staged.md',
    ].join('\n')
    renderPanel()

    expect(groupPaths('Conflicts')).toEqual(['notes/conflicted.md', 'notes/both-added.md'])
    expect(groupPaths('Changes')).toEqual(['notes/modified.md'])
    expect(groupPaths('Staged')).toEqual(['notes/staged.md'])
    expect(groupHeading('Conflicts')!.textContent).toContain('Conflicts (2)')
    expect(groupHeading('Changes')!.textContent).toContain('Changes (1)')
    expect(groupHeading('Staged')!.textContent).toContain('Staged (1)')
    expect(document.querySelectorAll('button[title="notes/conflicted.md"]')).toHaveLength(1)
  })

  it('shows a conflict with the danger marker and two distinct actions', () => {
    gitState.status = 'UU notes/conflicted.md'
    renderPanel()

    const row = groupSection('Conflicts')!
    expect(row.textContent).not.toContain('Working tree is clean.')
    expect(groupSection('Changes')).toBeNull()
    expect(groupSection('Staged')).toBeNull()
    expect(groupPaths('Conflicts')).toEqual(['notes/conflicted.md'])
    expect(stageButton('notes/conflicted.md')).not.toBeNull()
    expect(stageButton('notes/conflicted.md')!.disabled).toBe(false)
    expect(document.body.textContent).toContain('Nothing here counts as staged until you do')
  })

  it('stages a conflicted path and re-polls the status', async () => {
    gitState.status = 'UU notes/conflicted.md'
    renderPanel()

    act(() => stageButton('notes/conflicted.md')!.click())
    await flush()

    expect(invoke).toHaveBeenCalledWith('git_stage', { path: 'notes/conflicted.md' })
    expect(pollGitStatus).toHaveBeenCalled()
  })

  it('shows a staging error and still re-polls the status', async () => {
    gitState.status = 'UU notes/conflicted.md'
    invoke.mockRejectedValueOnce(new Error('Cannot stage unresolved file'))
    renderPanel()

    act(() => stageButton('notes/conflicted.md')!.click())
    await flush()

    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Cannot stage unresolved file')
    expect(pollGitStatus).toHaveBeenCalled()
  })

  it('still opens a conflicted file from its row while offering Stage beside it', () => {
    gitState.status = 'UU notes/sub/conflicted.md'
    renderPanel()

    const row = rowByPath('notes/sub/conflicted.md')!
    expect(row.textContent).toContain('conflicted.md')
    expect(row.textContent).toContain('notes/sub')

    act(() => row.click())
    expect(editorState.openFile).toHaveBeenCalledWith('notes/sub/conflicted.md', 'conflicted.md')
  })

  it('leaves an ordinary conflict-free merge conflict row unstaged', () => {
    gitState.status = 'AU notes/added-by-us.md'
    renderPanel()

    expect(groupPaths('Conflicts')).toEqual(['notes/added-by-us.md'])
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

  it('uses the Sync menu instead of a standalone refresh action', () => {
    renderPanel()

    expect(document.querySelector('[aria-label="Refresh git changes"]')).toBeNull()
    expect(syncMenuButton()).not.toBeNull()
    expect(syncButton('Fetch')).toBeUndefined()
    openSync()
    expect(syncButton('Fetch')).toBeDefined()
  })

  it('uses the shared local sidebar popover geometry', () => {
    renderPanel()
    openSync()

    const panel = document.querySelector('[aria-label="Git Panel"]')!
    const popover = panel.querySelector('.ui-popover') as HTMLElement
    expect(popover).not.toBeNull()
    expect(popover.className).toContain('absolute')
    expect(popover.className).toContain('inset-x-0')
    expect(popover.className).not.toContain('fixed')
    expect(popover.parentElement?.closest('[aria-label="Git Panel"]')).toBe(panel)
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

describe('GitPanel — remote sync', () => {
  it('fetches the resolved remote and refreshes the status', async () => {
    invoke.mockResolvedValue(syncOutcome())
    renderPanel()
    openSync()

    act(() => syncButton('Fetch')!.click())
    await flush()

    expect(invoke).toHaveBeenCalledWith('git_fetch', { name: 'origin' })
    expect(pollGitStatus).toHaveBeenCalled()
    expect(document.body.textContent).toContain('Fetched origin')
  })

  it('rebases onto the remote branch and surfaces conflicts', async () => {
    gitState.behind = 1
    invoke.mockResolvedValue(syncOutcome({ success: false, message: 'origin/main has conflicts — resolve them and commit', conflicts: ['notes/a.md'] }))
    renderPanel()
    openSync()

    act(() => syncButton('Rebase')!.click())
    await flush()

    expect(invoke).toHaveBeenCalledWith('git_fetch', { name: 'origin' })
    expect(invoke).toHaveBeenCalledWith('git_rebase', { name: 'origin', branch: 'main' })
    expect(document.body.textContent).toContain('notes/a.md')
    expect(vaultTree.loadTree).toHaveBeenCalled()
  })

  it('merges the remote branch and reports the outcome', async () => {
    gitState.behind = 1
    invoke.mockResolvedValue(syncOutcome({ message: 'Fast-forwarded to origin/main' }))
    renderPanel()
    openSync()

    act(() => syncButton('Merge')!.click())
    await flush()

    expect(invoke).toHaveBeenCalledWith('git_remote_merge', { name: 'origin', branch: 'main' })
    expect(document.body.textContent).toContain('Fast-forwarded to origin/main')
    expect(pollGitStatus).toHaveBeenCalled()
  })

  it('keeps a conflicted merge for Commit instead of resolving it', async () => {
    gitState.behind = 1
    invoke.mockResolvedValue(syncOutcome({ success: false, message: 'origin/main has conflicts — resolve them and commit', conflicts: ['notes/a.md'] }))
    renderPanel()
    openSync()

    act(() => syncButton('Merge')!.click())
    await flush()

    expect(document.body.textContent).toContain('origin/main has conflicts')
    expect(document.body.textContent).not.toContain('Fast-forwarded')
    expect(syncMenuButton()!.textContent).not.toContain('Synced')
  })

  it('disables Sync when no remote resolves', () => {
    gitState.hasRemote = false
    gitState.pushTarget = ''
    gitState.remotes = []
    renderPanel()

    expect(syncMenuButton()!.disabled).toBe(true)
    expect(syncButton('Fetch')).toBeUndefined()
    expect(document.body.textContent).toContain('Add a remote in Git settings to sync.')
  })

  it('offers a remote selector when several remotes exist', () => {
    gitState.remotes = ['origin', 'backup']
    gitState.pushTarget = 'origin'
    renderPanel()
    openSync()

    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Sync remote"]')
    expect(select).not.toBeNull()
    expect(Array.from(select!.options, option => option.value)).toEqual(['origin', 'backup'])
    expect(document.body.textContent).not.toContain('origin/main')
    expect(syncMenuButton()!.title).toBe('Sync main with origin')
  })

  it('syncs with the remote picked from the selector', async () => {
    gitState.remotes = ['origin', 'backup']
    gitState.pushTarget = 'origin'
    invoke.mockResolvedValue(syncOutcome())
    renderPanel()
    openSync()

    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Sync remote"]')!
    /** A real user picks an option (setting `value`) and the browser then fires
     *  `change`. React 19 does not auto-flush discrete events inside act, so the
     *  state update is asserted via the effect it has on the sync request. */
    act(() => {
      select.value = 'backup'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    act(() => syncButton('Fetch')!.click())
    await flush()

    expect(invoke).toHaveBeenCalledWith('git_fetch', { name: 'backup' })
    expect(document.body.textContent).toContain('Fetched backup')
    expect(document.body.textContent).not.toContain('Fetched origin')
  })

  it('ignores a stored remote that is missing from the refreshed list', async () => {
    gitState.remotes = ['origin', 'backup']
    gitState.pushTarget = 'origin'
    invoke.mockResolvedValue(syncOutcome())
    renderPanel()
    openSync()

    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Sync remote"]')!
    act(() => {
      select.value = 'backup'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    /** The remote disappears between two polls — as a poll would observe it. */
    gitState.remotes = ['origin']
    act(() => root!.render(<GitPanel />))

    expect(document.body.textContent).not.toContain('origin/main')
    expect(syncMenuButton()!.title).toBe('Sync main with origin')

    act(() => syncButton('Fetch')!.click())
    await flush()

    expect(invoke).toHaveBeenCalledWith('git_fetch', { name: 'origin' })
  })

  it('disables Rebase on a repository with no commits yet', () => {
    gitState.hasCommits = false
    renderPanel()
    openSync()

    const rebase = syncButton('Rebase')!
    expect(rebase.disabled).toBe(true)
    expect(rebase.title).toContain('No local commits yet')
    expect(syncButton('Merge')!.disabled).toBe(false)
  })

  it('locks Rebase and Merge until the remote is actually ahead', () => {
    gitState.behind = 0
    renderPanel()
    openSync()

    expect(syncButton('Rebase')!.disabled).toBe(true)
    expect(syncButton('Merge')!.disabled).toBe(true)
    expect(syncButton('Fetch')!.disabled).toBe(false)
    expect(document.body.textContent).toContain('remote has no new commits')
  })

  it('shows the incoming commit count next to the actions that use it', () => {
    gitState.behind = 2
    renderPanel()
    openSync()

    expect(syncButton('Rebase')!.textContent).toContain('↓2')
    expect(syncButton('Merge')!.textContent).toContain('↓2')
  })

  it('keeps Merge and Rebase available with local changes, since the backend judges safety', () => {
    gitState.behind = 1
    gitState.status = '.M notes/dirty.md'
    renderPanel()
    openSync()

    expect(syncButton('Merge')!.disabled).toBe(false)
    expect(syncButton('Rebase')!.disabled).toBe(false)
  })

  it('does not treat staged or untracked work as a sync gate', () => {
    gitState.behind = 1
    gitState.status = ['M. notes/staged.md', '?? notes/untracked.md', 'UU notes/conflicted.md'].join('\n')
    renderPanel()
    openSync()

    expect(syncButton('Merge')!.disabled).toBe(false)
    expect(syncButton('Rebase')!.disabled).toBe(false)
    expect(document.body.textContent).not.toContain('Commit your local changes')
  })

  it('swaps the sync actions for Continue/Abort during a rebase', () => {
    gitState.repoState = 'rebase'
    renderPanel()

    expect(syncButton('Fetch')).toBeUndefined()
    expect(syncButton('Rebase')).toBeUndefined()
    expect(syncButton('Merge')).toBeUndefined()
    expect(syncButton('Continue')).toBeDefined()
    expect(syncButton('Abort')).toBeDefined()
    expect(document.body.textContent).toContain('Rebase in progress')
  })

  it('offers only Abort during a merge — Continue belongs to rebases', () => {
    gitState.repoState = 'merge'
    renderPanel()

    expect(syncButton('Fetch')).toBeUndefined()
    expect(syncButton('Rebase')).toBeUndefined()
    expect(syncButton('Merge')).toBeUndefined()
    expect(syncButton('Continue')).toBeUndefined()
    expect(syncButton('Abort')).toBeDefined()
    expect(document.body.textContent).toContain('Merge in progress')
    expect(document.body.textContent).not.toContain('Rebase in progress')
  })

  it('points at system Git for a state it cannot finish itself', () => {
    gitState.repoState = 'cherry-pick'
    renderPanel()

    expect(document.body.textContent).toContain('cherry-pick is in progress')
    expect(document.body.textContent).toContain('system Git')
    expect(syncButton('Continue')).toBeUndefined()
    expect(syncButton('Abort')).toBeUndefined()
    expect(syncMenuButton()!.disabled).toBe(true)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('never routes Abort to a merge while another operation is running', () => {
    gitState.repoState = 'revert'
    renderPanel()

    expect(syncButton('Abort')).toBeUndefined()
    expect(invoke).not.toHaveBeenCalledWith('git_merge_abort')
    expect(invoke).not.toHaveBeenCalledWith('git_rebase_abort')
  })

  it('disables Rebase on a fresh repository but keeps Merge available', () => {
    gitState.hasCommits = false
    renderPanel()
    openSync()

    expect(syncButton('Rebase')!.disabled).toBe(true)
    expect(syncButton('Rebase')!.title).toContain('No local commits yet')
    expect(syncButton('Merge')!.disabled).toBe(false)
  })

  it('continues a rebase after the conflicts are resolved', async () => {
    gitState.repoState = 'rebase'
    invoke.mockResolvedValue(syncOutcome({ message: 'Rebase applied' }))
    renderPanel()

    act(() => syncButton('Continue')!.click())
    await flush()

    expect(invoke).toHaveBeenCalledWith('git_rebase_continue')
    expect(document.body.textContent).toContain('Rebase applied')
    expect(vaultTree.loadTree).toHaveBeenCalled()
  })

  it('aborts a merge only after confirmation', async () => {
    gitState.repoState = 'merge'
    renderPanel()

    expect(document.body.textContent).toContain('Merge in progress')
    act(() => syncButton('Abort')!.click())

    expect(confirmDialog()).not.toBeNull()
    expect(confirmDialog()!.textContent).toContain('Abort the merge?')
    expect(confirmDialog()!.textContent).toContain('Every uncommitted change made during the merge is discarded')
    expect(invoke).not.toHaveBeenCalledWith('git_merge_abort')

    act(() => dialogButton('Abort')!.click())
    await flush()

    expect(invoke).toHaveBeenCalledWith('git_merge_abort')
    expect(invoke).not.toHaveBeenCalledWith('git_rebase_abort')
    expect(confirmDialog()).toBeNull()
  })

  it('aborts a rebase only after confirmation', async () => {
    gitState.repoState = 'rebase'
    renderPanel()

    act(() => syncButton('Abort')!.click())
    expect(confirmDialog()!.textContent).toContain('Abort the rebase?')
    expect(confirmDialog()!.textContent).toContain('Every uncommitted change made during the rebase is discarded')

    act(() => dialogButton('Abort')!.click())
    await flush()

    expect(invoke).toHaveBeenCalledWith('git_rebase_abort')
    expect(invoke).not.toHaveBeenCalledWith('git_merge_abort')
  })

  it('cancels the abort without touching the in-progress operation', () => {
    gitState.repoState = 'rebase'
    renderPanel()

    act(() => syncButton('Abort')!.click())
    act(() => dialogButton('Cancel')!.click())

    expect(confirmDialog()).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('dismisses the abort confirmation with Escape', () => {
    gitState.repoState = 'merge'
    renderPanel()

    act(() => syncButton('Abort')!.click())
    act(() => confirmDialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))

    expect(confirmDialog()).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('git_merge_abort')
  })

  it('ignores other keys while the abort confirmation is open', () => {
    gitState.repoState = 'merge'
    renderPanel()

    act(() => syncButton('Abort')!.click())
    act(() => confirmDialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))

    expect(confirmDialog()).not.toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })
})
