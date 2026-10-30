import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEditorStore } from '../../../frontend/stores/editor'
import { useSyncStore, contentVersion } from '../../../frontend/stores/sync'
import { invoke, IpcError } from '../../../frontend/lib/ipc'

vi.mock('../../../frontend/lib/ipc', () => ({
  invoke: vi.fn(),
  listen: vi.fn().mockResolvedValue(() => {}),
  IpcError: class IpcError extends Error { status?: number; constructor(message: string, status?: number) { super(message); this.status = status } },
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function backend(initial: string) {
  const state = { disk: initial, failNext: false }
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'file_version') return contentVersion(state.disk)
    if (cmd === 'write_file_checked') {
      if (state.failNext) {
        state.failNext = false
        throw new IpcError('timed out', 503)
      }
      if (args?.baseVersion !== contentVersion(state.disk)) {
        return JSON.stringify({ status: 'conflict', disk: state.disk, version: contentVersion(state.disk), reason: 'version_mismatch' })
      }
      state.disk = args?.content as string
      return JSON.stringify({ status: 'written', version: contentVersion(state.disk) })
    }
    return ''
  })
  return state
}

describe('Keep mine after typing on', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSyncStore.getState().reset()
  })

  it('writes the tab’s latest edit, not the one the conflict captured', async () => {
    // Another writer changed the file after the tab loaded it.
    const server = backend('theirs\n')
    useEditorStore.setState({
      tabs: [{ path: 'a.md', name: 'a.md', content: 'base\n', frontmatter: '', editedContent: 'mine', dirty: true, deleted: false, baseVersion: contentVersion('base\n') }],
      activeTab: 'a.md',
      _flushEditor: null,
    })
    await useEditorStore.getState().persistAllDirty()
    expect(useSyncStore.getState().conflicts[0].mine).toBe('mine\n')
    const id = useSyncStore.getState().conflicts[0].id

    // The user keeps typing while the dialog is up; the last keystrokes are
    // still only in the editor until its flush.
    useEditorStore.setState({ _flushEditor: () => useEditorStore.getState().setEditedContent('a.md', 'mine, and more') })

    // A retryable failure defers the write: the conflict stays open, now
    // holding the newer edit, under the same id (a dismissed dialog stays dismissed).
    server.failNext = true
    await useEditorStore.getState().applyConflictMine('a.md')
    expect(server.disk).toBe('theirs\n')
    expect(useSyncStore.getState().conflicts[0]).toMatchObject({ id, mine: 'mine, and more\n' })

    await useEditorStore.getState().applyConflictMine('a.md')
    expect(server.disk).toBe('mine, and more\n')
    const t = useEditorStore.getState().tabs[0]
    expect(t).toMatchObject({ content: 'mine, and more\n', dirty: false })
    expect(t.baseVersion).toBe(contentVersion('mine, and more\n'))
    expect(useSyncStore.getState().conflicts).toHaveLength(0)
  })

  it('writes the captured edit for a conflict whose tab is not open', async () => {
    const server = backend('theirs\n')
    useEditorStore.setState({ tabs: [], activeTab: null, _flushEditor: null })
    useSyncStore.getState().addConflict({ path: 'a.md', mine: 'queued\n', theirs: 'theirs\n', theirsVersion: contentVersion('theirs\n'), baseContent: null })
    await useEditorStore.getState().applyConflictMine('a.md')
    expect(server.disk).toBe('queued\n')
  })
})
