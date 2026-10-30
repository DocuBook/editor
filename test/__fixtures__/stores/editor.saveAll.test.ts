import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEditorStore } from '../../../frontend/stores/editor'
import { useSyncStore } from '../../../frontend/stores/sync'
import { invoke } from '../../../frontend/lib/ipc'

vi.mock('../../../frontend/lib/ipc', () => ({
  invoke: vi.fn(),
  listen: vi.fn().mockResolvedValue(() => {}),
  IpcError: class IpcError extends Error { status?: number; constructor(message: string, status?: number) { super(message); this.status = status } },
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const tab = (path: string) => ({ path, name: path, content: 'old\n', frontmatter: '', editedContent: `new ${path}`, dirty: true, deleted: false, baseVersion: 'v0' })

/** Writes to the paths in `broken` fail the way a permission error does: a
 *  permanent error, not one the offline queue would retry. */
function mockWrites(broken: string[]) {
  const written: string[] = []
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd !== 'write_file_checked') return ''
    const path = args?.path as string
    if (broken.includes(path)) throw new Error('Write: Permission denied (os error 13)')
    written.push(path)
    return JSON.stringify({ status: 'written', version: 'v1' })
  })
  return written
}

describe('persistAllDirty with a tab that cannot be written', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSyncStore.getState().reset()
    useEditorStore.setState({ tabs: [tab('a.md'), tab('b.md'), tab('c.md')], activeTab: 'a.md', _flushEditor: null })
  })

  it('still saves every other dirty tab, then reports the failure', async () => {
    const written = mockWrites(['a.md'])
    await expect(useEditorStore.getState().persistAllDirty()).rejects.toThrow('Could not save a.md')
    expect(written).toEqual(['b.md', 'c.md'])
    const dirty = useEditorStore.getState().tabs.filter(t => t.dirty).map(t => t.path)
    expect(dirty).toEqual(['a.md'])
  })

  it('names every tab that failed', async () => {
    mockWrites(['a.md', 'c.md'])
    await expect(useEditorStore.getState().persistAllDirty()).rejects.toThrow('Could not save a.md, c.md')
  })
})
