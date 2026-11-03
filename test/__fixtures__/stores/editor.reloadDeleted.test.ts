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

/** `read_file` answers from `files`; a path in `failing` throws that error instead. */
function vault(files: Record<string, string>, failing: Record<string, string> = {}) {
  const writes: { path: string; baseVersion: unknown }[] = []
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    const path = args?.path as string
    if (cmd === 'read_file') {
      if (path in failing) throw new Error(failing[path])
      if (!(path in files)) throw new Error('No such file or directory (os error 2)')
      return files[path]
    }
    if (cmd === 'file_version') {
      if (!(path in files)) throw new Error('No such file or directory (os error 2)')
      return contentVersion(files[path])
    }
    if (cmd === 'write_file_checked') {
      writes.push({ path, baseVersion: args?.baseVersion })
      return JSON.stringify({ status: 'conflict', disk: files[path] ?? '', version: contentVersion(files[path] ?? ''), reason: 'version_mismatch' })
    }
    return ''
  })
  return { writes }
}

const openTab = (path: string, extra: Record<string, unknown> = {}) =>
  ({ path, name: path, content: 'old\n', frontmatter: '', editedContent: 'old', dirty: false, deleted: false, baseVersion: contentVersion('old\n'), ...extra })
const tab = (path: string) => useEditorStore.getState().tabs.find(t => t.path === path)!

describe('reloadAllTabs after a branch switch', () => {
  beforeEach(() => {
    clearEditorCache()
    vi.clearAllMocks()
    useSyncStore.getState().reset()
    useEditorStore.setState({ tabs: [], activeTab: null, _flushEditor: null })
  })

  it('marks a tab deleted when its file is gone on the new branch', async () => {
    vault({})
    useEditorStore.setState({ tabs: [openTab('a.md')], activeTab: 'a.md' })
    await useEditorStore.getState().reloadAllTabs()
    expect(tab('a.md').deleted).toBe(true)
  })

  /** The backend words a missing file as `Read: not found: <path>` on every
   *  platform (the lookup runs before the open), or `os error 2`. */
  it.each(['Read: not found: a.md', 'No such file or directory (os error 2)'])('marks a tab deleted for the missing-file error %s', async (message) => {
    vault({}, { 'a.md': message })
    useEditorStore.setState({ tabs: [openTab('a.md')], activeTab: 'a.md' })
    await useEditorStore.getState().reloadAllTabs()
    expect(tab('a.md').deleted).toBe(true)
  })

  /** Permission failures: EACCES on Linux/Windows, and EPERM, which macOS
   *  raises for a folder the app has no grant for. */
  it.each([
    'Permission denied (os error 13)',
    'Read: Operation not permitted (os error 1)',
    // errno 20-29 hit files that exist: they must not read as "os error 2".
    'Read: Too many open files (os error 24)',
    'Read: Invalid argument (os error 22)',
    'Read: The device is not ready. (os error 21)',
  ])('does not mark a tab deleted for the transient read error %s', async (message) => {
    vault({}, { 'a.md': message })
    useEditorStore.setState({ tabs: [openTab('a.md')], activeTab: 'a.md' })
    await useEditorStore.getState().reloadAllTabs()
    expect(tab('a.md').deleted).toBe(false)
  })

  it('revives a dirty deleted tab whose file the new branch brings back', async () => {
    vault({ 'a.md': 'back\n' })
    useEditorStore.setState({ tabs: [openTab('a.md', { dirty: true, deleted: true, editedContent: 'typed' })], activeTab: 'a.md' })
    await useEditorStore.getState().reloadAllTabs()
    expect(tab('a.md').deleted).toBe(false)
    expect(tab('a.md').editedContent).toBe('typed')
  })

  /** The revived tab keeps its old baseline: if a different file came back, the
   *  save is rejected as a conflict instead of overwriting it. */
  it('saves a revived dirty tab against its old baseline', async () => {
    const server = vault({ 'a.md': 'different file\n' })
    useEditorStore.setState({ tabs: [openTab('a.md', { dirty: true, deleted: true, editedContent: 'typed' })], activeTab: 'a.md' })
    await useEditorStore.getState().reloadAllTabs()
    await useEditorStore.getState().persistAllDirty()

    expect(server.writes).toEqual([{ path: 'a.md', baseVersion: contentVersion('old\n') }])
    expect(useSyncStore.getState().conflicts.some(c => c.path === 'a.md')).toBe(true)
  })

  /** `restoreSessionTabs` closes a tab on not-found, so a file that exists but
   *  hit "Too many open files" must keep its tab. */
  it('keeps a restored session tab when the read hits a non-missing os error', async () => {
    vault({}, { 'a.md': 'Read: Too many open files (os error 24)' })
    useEditorStore.setState({ tabs: [openTab('a.md')], activeTab: 'a.md' })
    await useEditorStore.getState().restoreSessionTabs()
    expect(useEditorStore.getState().tabs.map(t => t.path)).toEqual(['a.md'])
  })

  it('revives a deleted binary tab whose file the new branch brings back', async () => {
    vault({ 'img.png': 'bytes' })
    useEditorStore.setState({ tabs: [openTab('img.png', { deleted: true })], activeTab: 'img.png' })
    await useEditorStore.getState().reloadAllTabs()
    expect(tab('img.png').deleted).toBe(false)
  })
})
