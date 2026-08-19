import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEditorStore } from './editor'

vi.mock('../lib/ipc', () => ({
  invoke: vi.fn().mockResolvedValue(''),
  listen: vi.fn().mockResolvedValue(() => {}),
}))

/** Regression: renaming a file in the sidebar must remap the open tab's path
 *  and name — otherwise the tab keeps the OLD path (save would recreate the
 *  old file via write_file's create-dirs, git status / wiki backlinks resolve
 *  the wrong path) and the OLD name (visible mismatch with the sidebar tree). */
describe('editor store renameTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useEditorStore.setState({
      tabs: [], activeTab: null, editMode: 'editor', blockEditor: null,
      canUndo: false, canRedo: false, _flushEditor: null,
    })
  })

  it('remaps path and name of the renamed tab, including activeTab', () => {
    useEditorStore.setState({
      tabs: [
        { path: 'notes/old.md', name: 'old.md', content: '# c', frontmatter: '', editedContent: null, dirty: false, deleted: false },
        { path: 'journal/day.md', name: 'day.md', content: '# d', frontmatter: '', editedContent: null, dirty: false, deleted: false },
      ],
      activeTab: 'notes/old.md',
    })
    useEditorStore.getState().renameTab('notes/old.md', 'notes/renamed.md')

    const { tabs, activeTab } = useEditorStore.getState()
    expect(tabs.some(t => t.path === 'notes/old.md')).toBe(false)
    const renamed = tabs.find(t => t.path === 'notes/renamed.md')!
    expect(renamed.name).toBe('renamed.md')
    expect(renamed.content).toBe('# c') // preserved
    expect(activeTab).toBe('notes/renamed.md')
    // other tab untouched
    expect(tabs.find(t => t.path === 'journal/day.md')?.name).toBe('day.md')
  })

  it('flushes the renamed tab when active (unsaved WYSIWYG edits reach the store before remap)', () => {
    const spy = vi.fn()
    useEditorStore.setState({
      tabs: [{ path: 'a.md', name: 'a.md', content: '# a', frontmatter: '', editedContent: null, dirty: true, deleted: false }],
      activeTab: 'a.md',
      _flushEditor: spy,
    })
    useEditorStore.getState().renameTab('a.md', 'b.md')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(useEditorStore.getState().activeTab).toBe('b.md')
  })

  it('does not flush when renaming a non-active tab (it was flushed on last switch)', () => {
    const spy = vi.fn()
    useEditorStore.setState({
      tabs: [
        { path: 'a.md', name: 'a.md', content: '# a', frontmatter: '', editedContent: null, dirty: false, deleted: false },
        { path: 'b.md', name: 'b.md', content: '# b', frontmatter: '', editedContent: null, dirty: false, deleted: false },
      ],
      activeTab: 'b.md',
      _flushEditor: spy,
    })
    useEditorStore.getState().renameTab('a.md', 'c.md')
    expect(spy).not.toHaveBeenCalled()
    expect(useEditorStore.getState().activeTab).toBe('b.md')
    expect(useEditorStore.getState().tabs.find(t => t.path === 'c.md')?.name).toBe('c.md')
  })

  it('drops the old tab when the rename target is already open (no duplicate paths)', () => {
    useEditorStore.setState({
      tabs: [
        { path: 'a.md', name: 'a.md', content: '# a', frontmatter: '', editedContent: null, dirty: false, deleted: false },
        { path: 'b.md', name: 'b.md', content: '# b', frontmatter: '', editedContent: null, dirty: false, deleted: false },
      ],
      activeTab: 'a.md',
    })
    useEditorStore.getState().renameTab('a.md', 'b.md') // renaming a.md onto the open b.md
    const { tabs } = useEditorStore.getState()
    expect(tabs.some(t => t.path === 'a.md')).toBe(false)
    expect(tabs.filter(t => t.path === 'b.md').length).toBe(1) // no duplicate
    expect(useEditorStore.getState().activeTab).toBe('b.md')
  })

  it('is a no-op when the file is not open', () => {
    useEditorStore.setState({ tabs: [], activeTab: null })
    useEditorStore.getState().renameTab('ghost.md', 'real.md')
    expect(useEditorStore.getState().tabs).toEqual([])
  })
})