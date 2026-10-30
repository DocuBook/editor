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

const DISK = 'hello\n'

/** The web server's command results are JSON text, so `file_version` arrives
 *  JSON-encoded (`"\"<hash>\""`); desktop returns the bare hash. The guarded
 *  write compares against the bare hash in both runtimes. */
function mockBackend(versionShape: 'web' | 'desktop') {
  let disk = DISK
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'read_file') return disk
    if (cmd === 'file_version') {
      const hash = contentVersion(disk)
      return versionShape === 'web' ? JSON.stringify(hash) : hash
    }
    if (cmd === 'write_file_checked') {
      if (args?.baseVersion !== contentVersion(disk)) {
        return JSON.stringify({ status: 'conflict', disk, version: contentVersion(disk), reason: 'version_mismatch' })
      }
      disk = args?.content as string
      return JSON.stringify({ status: 'written', version: contentVersion(disk) })
    }
    return ''
  })
}

const baseline = () => useEditorStore.getState().tabs[0]?.baseVersion

async function editAndSave() {
  useEditorStore.getState().setEditedContent('a.md', 'hello world')
  useEditorStore.getState().setTabDirty('a.md', true)
  await useEditorStore.getState().persistAllDirty()
}

describe('file version baseline on both runtimes', () => {
  beforeEach(() => {
    clearEditorCache()
    vi.clearAllMocks()
    useSyncStore.getState().reset()
    useEditorStore.setState({ tabs: [], activeTab: null, _flushEditor: null })
  })

  for (const shape of ['web', 'desktop'] as const) {
    it(`a tab restored after a vault resume saves without a conflict (${shape})`, async () => {
      mockBackend(shape)
      useEditorStore.setState({ tabs: [{ path: 'a.md', name: 'a.md', content: null, frontmatter: '', editedContent: null, dirty: false, deleted: false }], activeTab: 'a.md' })
      await useEditorStore.getState().restoreSessionTabs()
      expect(baseline()).toBe(contentVersion(DISK))

      await editAndSave()
      expect(useSyncStore.getState().conflicts).toHaveLength(0)
    })

    it(`a tab reloaded after a branch switch saves without a conflict (${shape})`, async () => {
      mockBackend(shape)
      useEditorStore.setState({ tabs: [{ path: 'a.md', name: 'a.md', content: 'old\n', frontmatter: '', editedContent: 'old', dirty: false, deleted: false, baseVersion: contentVersion('old\n') }], activeTab: 'a.md' })
      await useEditorStore.getState().reloadAllTabs()
      expect(baseline()).toBe(contentVersion(DISK))

      await editAndSave()
      expect(useSyncStore.getState().conflicts).toHaveLength(0)
    })

    it(`a freshly opened tab keeps a bare hash (${shape})`, async () => {
      mockBackend(shape)
      await useEditorStore.getState().openFile('a.md', 'a.md')
      expect(baseline()).toBe(contentVersion(DISK))
    })
  }

  it('reads a JSON null version as no version, not the string "null"', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'read_file') return DISK
      if (cmd === 'file_version') return 'null'
      return ''
    })
    await useEditorStore.getState().openFile('a.md', 'a.md')
    // Falls back to hashing what was read instead of keeping "null".
    expect(baseline()).toBe(contentVersion(DISK))
  })
})
