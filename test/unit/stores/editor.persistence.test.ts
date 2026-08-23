import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEditorStore } from '../../../frontend/stores/editor'
import { invoke } from '../../../frontend/lib/ipc'

vi.mock('../../../frontend/lib/ipc', () => ({
  invoke: vi.fn().mockResolvedValue(''),
  listen: vi.fn().mockResolvedValue(() => {}),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

describe('editor store tab persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useEditorStore.setState({ tabs: [], activeTab: null, _flushEditor: null })
  })

  it('does not write unchanged files or auto-save when switching tabs', async () => {
    useEditorStore.setState({
      tabs: [
        { path: 'a.md', name: 'a.md', content: 'a', frontmatter: '', editedContent: null, dirty: false, deleted: false },
        { path: 'b.md', name: 'b.md', content: 'b', frontmatter: '', editedContent: null, dirty: false, deleted: false },
      ],
      activeTab: 'a.md',
    })

    useEditorStore.getState().switchTab('b.md')
    await useEditorStore.getState().closeTab('b.md')

    expect(invoke).not.toHaveBeenCalledWith('write_file', expect.anything())
  })

  it('writes a dirty active tab on close, including content edited to empty', async () => {
    useEditorStore.setState({
      tabs: [{ path: 'a.md', name: 'a.md', content: 'old', frontmatter: '', editedContent: '', dirty: true, deleted: false }],
      activeTab: 'a.md',
    })

    await useEditorStore.getState().closeTab('a.md')

    expect(invoke).toHaveBeenCalledWith('write_file', { path: 'a.md', content: '' })
  })

  it('keeps a dirty tab open and reports when its save fails', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('disk full'))
    useEditorStore.setState({
      tabs: [{ path: 'a.md', name: 'a.md', content: 'old', frontmatter: '', editedContent: 'changed', dirty: true, deleted: false }],
      activeTab: 'a.md',
    })

    await useEditorStore.getState().closeTab('a.md')

    expect(useEditorStore.getState().tabs).toHaveLength(1)
    expect(useEditorStore.getState().activeTab).toBe('a.md')
  })

  it('rejects persistAllDirty when any dirty file cannot be saved', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('disk full'))
    useEditorStore.setState({
      tabs: [{ path: 'a.md', name: 'a.md', content: 'old', frontmatter: '', editedContent: 'changed', dirty: true, deleted: false }],
      activeTab: 'a.md',
    })

    await expect(useEditorStore.getState().persistAllDirty()).rejects.toThrow('Could not save a.md')
  })

  it('does not save a dirty inactive tab when it is closed', async () => {
    useEditorStore.setState({
      tabs: [
        { path: 'a.md', name: 'a.md', content: 'old', frontmatter: '', editedContent: 'changed', dirty: true, deleted: false },
        { path: 'b.md', name: 'b.md', content: 'b', frontmatter: '', editedContent: null, dirty: false, deleted: false },
      ],
      activeTab: 'b.md',
    })

    await useEditorStore.getState().closeTab('a.md')

    expect(invoke).not.toHaveBeenCalledWith('write_file', expect.anything())
  })
})
