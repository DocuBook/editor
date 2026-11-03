import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEditorStore } from '../../../frontend/stores/editor'
import { useSyncStore, contentVersion } from '../../../frontend/stores/sync'
import { invoke } from '../../../frontend/lib/ipc'
import { clearEditorCache } from '../../../frontend/utils/editorCache'

vi.mock('../../../frontend/lib/ipc', () => ({
  invoke: vi.fn(),
  listen: vi.fn().mockResolvedValue(() => {}),
  IpcError: class IpcError extends Error { status?: number; constructor(message: string, status?: number) { super(message); this.status = status } },
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

/** A vault keyed by path: a missing key reads as "no such file". */
function vault(files: Record<string, string>) {
  const writes: string[] = []
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    const path = args?.path as string
    if (cmd === 'read_file') {
      if (!(path in files)) throw new Error('No such file or directory (os error 2)')
      return files[path]
    }
    if (cmd === 'file_version') return contentVersion(files[path])
    if (cmd === 'write_file_checked') {
      files[path] = args?.content as string
      writes.push(path)
      return JSON.stringify({ status: 'written', version: contentVersion(files[path]) })
    }
    return ''
  })
  return { files, writes }
}

const deletedTab = (path: string, extra: Record<string, unknown> = {}) =>
  ({ path, name: path.split('/').pop()!, content: 'old\n', frontmatter: '', editedContent: 'old', dirty: false, deleted: true, baseVersion: contentVersion('old\n'), ...extra })
const tab = (path: string) => useEditorStore.getState().tabs.find(t => t.path === path)!

describe('reviveDeletedTabs', () => {
  beforeEach(() => {
    clearEditorCache()
    vi.clearAllMocks()
    useSyncStore.getState().reset()
    useEditorStore.setState({ tabs: [], activeTab: null, _flushEditor: null })
  })

  it('revives a deleted tab whose file is back, with the content on disk', async () => {
    vault({ 'a.md': 'restored\n' })
    useEditorStore.setState({ tabs: [deletedTab('a.md')], activeTab: 'a.md' })
    await useEditorStore.getState().reviveDeletedTabs()

    expect(tab('a.md').deleted).toBe(false)
    expect(tab('a.md').content).toBe('restored\n')
    expect(tab('a.md').baseVersion).toBe(contentVersion('restored\n'))
  })

  it('leaves a tab deleted while its file is still gone', async () => {
    vault({})
    useEditorStore.setState({ tabs: [deletedTab('a.md')], activeTab: 'a.md' })
    await useEditorStore.getState().reviveDeletedTabs()

    expect(tab('a.md').deleted).toBe(true)
  })

  /** macOS Finder's Trash reports `note.md` for `sub/note.md`, so a path derived
   *  from the trash entry would unflag the wrong tab. The disk names the right one. */
  it('revives only the tab whose file exists, not one that shares its basename', async () => {
    vault({ 'sub/note.md': 'restored\n' })
    useEditorStore.setState({ tabs: [deletedTab('sub/note.md'), deletedTab('note.md')], activeTab: 'sub/note.md' })
    await useEditorStore.getState().reviveDeletedTabs()

    expect(tab('sub/note.md').deleted).toBe(false)
    expect(tab('note.md').deleted).toBe(true)
  })

  it('keeps edits typed while deleted and saves them against the old baseline', async () => {
    const server = vault({ 'a.md': 'old\n' })
    useEditorStore.setState({ tabs: [deletedTab('a.md', { dirty: true, editedContent: 'typed while deleted' })], activeTab: 'a.md' })
    await useEditorStore.getState().reviveDeletedTabs()

    expect(tab('a.md').deleted).toBe(false)
    expect(tab('a.md').editedContent).toBe('typed while deleted')
    await useEditorStore.getState().persistAllDirty()
    expect(server.writes).toContain('a.md')
    expect(server.files['a.md']).toContain('typed while deleted')
  })

  it('does not touch live tabs', async () => {
    vault({ 'a.md': 'on disk\n' })
    useEditorStore.setState({ tabs: [deletedTab('a.md', { deleted: false })], activeTab: 'a.md' })
    await useEditorStore.getState().reviveDeletedTabs()

    expect(tab('a.md').content).toBe('old\n')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('limits the check to the given paths', async () => {
    vault({ 'a.md': 'a\n', 'b.md': 'b\n' })
    useEditorStore.setState({ tabs: [deletedTab('a.md'), deletedTab('b.md')], activeTab: 'a.md' })
    await useEditorStore.getState().reviveDeletedTabs(['b.md'])

    expect(tab('a.md').deleted).toBe(true)
    expect(tab('b.md').deleted).toBe(false)
  })
})

describe('reopening a path with a stale deleted tab', () => {
  beforeEach(() => {
    clearEditorCache()
    vi.clearAllMocks()
    useSyncStore.getState().reset()
    useEditorStore.setState({ tabs: [], activeTab: null, _flushEditor: null })
  })

  it('picks up the file that is back instead of showing the stale content', async () => {
    vault({ 'a.md': 'new note\n' })
    useEditorStore.setState({ tabs: [deletedTab('a.md')], activeTab: null })
    await useEditorStore.getState().openFile('a.md', 'a.md')

    expect(tab('a.md').deleted).toBe(false)
    expect(tab('a.md').content).toBe('new note\n')
    expect(useEditorStore.getState().activeTab).toBe('a.md')
  })

  it('keeps the tab deleted when the file is still missing', async () => {
    vault({})
    useEditorStore.setState({ tabs: [deletedTab('a.md')], activeTab: null })
    await useEditorStore.getState().openFile('a.md', 'a.md')

    expect(tab('a.md').deleted).toBe(true)
    expect(useEditorStore.getState().activeTab).toBe('a.md')
  })
})
