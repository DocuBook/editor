// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useEditorStore, installUnloadSave } from '../../../frontend/stores/editor'
import { useSyncStore } from '../../../frontend/stores/sync'
import { invoke } from '../../../frontend/lib/ipc'

vi.mock('../../../frontend/lib/ipc', () => ({
  invoke: vi.fn(),
  listen: vi.fn().mockResolvedValue(() => {}),
  IpcError: class IpcError extends Error { status?: number; constructor(message: string, status?: number) { super(message); this.status = status } },
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const writes = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'write_file_checked')

/** `write_file_checked` as the backend answers it: with no baseline it writes
 *  only while nothing exists at the path, so a file that came back is a conflict. */
function backend(opts: { fileBack?: boolean } = {}) {
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd !== 'write_file_checked') return ''
    if (args?.baseVersion === null && opts.fileBack) {
      return JSON.stringify({ status: 'conflict', disk: 'someone else\n', version: 'v-theirs', reason: 'exists' })
    }
    return JSON.stringify({ status: 'written', version: 'v-new' })
  })
}

const tab = (path: string, extra: Record<string, unknown> = {}) =>
  ({ path, name: path, content: 'old\n', frontmatter: '', editedContent: 'typed after delete', dirty: true, deleted: true, baseVersion: 'v-old', ...extra })
const paths = () => useEditorStore.getState().tabs.map(t => t.path)
const prompt = () => useEditorStore.getState().deletedPrompt
const asked = () => vi.waitFor(() => expect(prompt()).not.toBeNull())

describe('closing a tab whose file was deleted', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    backend()
    useSyncStore.getState().reset()
    useEditorStore.setState({ tabs: [tab('a.md')], activeTab: 'a.md', _flushEditor: null, deletedPrompt: null })
  })

  it('asks before dropping an edit, and keeps the tab until answered', async () => {
    const closing = useEditorStore.getState().closeTab('a.md')
    await asked()
    expect(prompt()).toEqual({ names: ['a.md'] })
    expect(paths()).toEqual(['a.md'])

    useEditorStore.getState().answerDeletedPrompt('cancel')
    await closing
    expect(paths()).toEqual(['a.md'])
    expect(writes()).toHaveLength(0)
    expect(prompt()).toBeNull()
  })

  it('Save recreates the file with no baseline, then closes', async () => {
    const closing = useEditorStore.getState().closeTab('a.md')
    await asked()
    useEditorStore.getState().answerDeletedPrompt('save')
    await closing

    expect(writes()).toHaveLength(1)
    expect(writes()[0][1]).toMatchObject({ path: 'a.md', content: 'typed after delete\n', baseVersion: null })
    expect(paths()).toEqual([])
  })

  it('Discard closes the tab without writing', async () => {
    const closing = useEditorStore.getState().closeTab('a.md')
    await asked()
    useEditorStore.getState().answerDeletedPrompt('discard')
    await closing

    expect(writes()).toHaveLength(0)
    expect(paths()).toEqual([])
  })

  it('never overwrites a file that came back: Save becomes a conflict and the tab stays', async () => {
    backend({ fileBack: true })
    const closing = useEditorStore.getState().closeTab('a.md')
    await asked()
    useEditorStore.getState().answerDeletedPrompt('save')
    await closing

    expect(useSyncStore.getState().conflicts.some(c => c.path === 'a.md')).toBe(true)
    expect(paths()).toEqual(['a.md'])
  })

  it('closes a deleted tab with nothing typed in it without asking', async () => {
    useEditorStore.setState({ tabs: [tab('a.md', { dirty: false, editedContent: 'old' })] })
    await useEditorStore.getState().closeTab('a.md')
    expect(prompt()).toBeNull()
    expect(paths()).toEqual([])
  })
})

describe('quitting the desktop app with edits in a deleted tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    backend()
    useSyncStore.getState().reset()
    useEditorStore.setState({ tabs: [tab('a.md'), tab('b.md')], activeTab: 'a.md', _flushEditor: null, deletedPrompt: null })
  })

  it('never recreates a deleted file by itself', async () => {
    await useEditorStore.getState().persistAllDirty()
    expect(writes()).toHaveLength(0)
  })

  it('asks once for all the deleted tabs and stays open on Cancel', async () => {
    const quitting = useEditorStore.getState().confirmDeletedBeforeQuit()
    await asked()
    expect(prompt()).toEqual({ names: ['a.md', 'b.md'] })
    useEditorStore.getState().answerDeletedPrompt('cancel')

    expect(await quitting).toBe(false)
    expect(writes()).toHaveLength(0)
  })

  it('lets the app quit on Discard, still without a write', async () => {
    const quitting = useEditorStore.getState().confirmDeletedBeforeQuit()
    await asked()
    useEditorStore.getState().answerDeletedPrompt('discard')

    expect(await quitting).toBe(true)
    expect(writes()).toHaveLength(0)
  })

  it('recreates each file on Save, then lets the app quit', async () => {
    const quitting = useEditorStore.getState().confirmDeletedBeforeQuit()
    await asked()
    useEditorStore.getState().answerDeletedPrompt('save')

    expect(await quitting).toBe(true)
    expect(writes().map(([, args]) => (args as { path: string }).path).sort()).toEqual(['a.md', 'b.md'])
  })

  it('stays open when a file came back, so the conflict can be resolved', async () => {
    backend({ fileBack: true })
    const quitting = useEditorStore.getState().confirmDeletedBeforeQuit()
    await asked()
    useEditorStore.getState().answerDeletedPrompt('save')

    expect(await quitting).toBe(false)
    expect(useSyncStore.getState().conflicts.length).toBeGreaterThan(0)
  })

  it('does not ask when no deleted tab has unsaved edits', async () => {
    useEditorStore.setState({ tabs: [tab('a.md', { dirty: false })] })
    expect(await useEditorStore.getState().confirmDeletedBeforeQuit()).toBe(true)
    expect(prompt()).toBeNull()
  })
})

describe('leaving the web build with edits in a deleted tab', () => {
  let uninstall: () => void
  beforeEach(() => {
    vi.clearAllMocks()
    backend()
    useSyncStore.getState().reset()
    useEditorStore.setState({ tabs: [tab('a.md')], activeTab: 'a.md', _flushEditor: null, deletedPrompt: null })
    uninstall = installUnloadSave()
  })
  afterEach(() => uninstall())

  it('asks the browser to confirm leaving, without writing the file', () => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(writes()).toHaveLength(0)
  })

  it('does not ask once the deleted tab has no unsaved edits', () => {
    useEditorStore.setState({ tabs: [tab('a.md', { dirty: false })] })
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})
