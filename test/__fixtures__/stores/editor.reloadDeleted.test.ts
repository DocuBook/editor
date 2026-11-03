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
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    const path = args?.path as string
    if (cmd === 'read_file') {
      if (path in failing) throw new Error(failing[path])
      if (!(path in files)) throw new Error('No such file or directory (os error 2)')
      return files[path]
    }
    if (cmd === 'file_version') return contentVersion(files[path] ?? '')
    return ''
  })
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
  it.each(['Permission denied (os error 13)', 'Read: Operation not permitted (os error 1)'])('does not mark a tab deleted for the transient read error %s', async (message) => {
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
})
