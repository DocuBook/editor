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

/** A backend whose file can change between calls. `afterRead` runs once,
 *  right after the first `read_file` answered: another writer landing in the
 *  gap before `file_version`. `lossy` makes reads return text whose hash is not
 *  the bytes' version, as a note with invalid UTF-8 does. */
function backend(initial: string, opts: { afterRead?: () => string; lossy?: boolean } = {}) {
  const state = { disk: initial, reads: 0 }
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'read_file') {
      const text = opts.lossy ? state.disk.replace('é', '�') : state.disk
      if (state.reads++ === 0 && opts.afterRead) state.disk = opts.afterRead()
      return text
    }
    if (cmd === 'file_version') return contentVersion(state.disk)
    if (cmd === 'write_file_checked') {
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

const tab = () => useEditorStore.getState().tabs[0]

async function editAndSave(text: string) {
  useEditorStore.getState().setEditedContent('a.md', text)
  useEditorStore.getState().setTabDirty('a.md', true)
  await useEditorStore.getState().persistAllDirty()
}

describe('a note read while another writer saves it', () => {
  beforeEach(() => {
    clearEditorCache()
    vi.clearAllMocks()
    useSyncStore.getState().reset()
    useEditorStore.setState({ tabs: [], activeTab: null, _flushEditor: null })
  })

  it('pairs the text it shows with the version of that text', async () => {
    const server = backend('old\n', { afterRead: () => 'theirs\n' })
    await useEditorStore.getState().openFile('a.md', 'a.md')
    expect(tab().content).toBe('theirs\n')
    expect(tab().baseVersion).toBe(contentVersion('theirs\n'))

    await editAndSave('theirs and mine')
    expect(server.disk).toBe('theirs and mine\n')
  })

  it('never overwrites the other write without a conflict', async () => {
    // The tab restored from the session hits the same gap.
    const server = backend('old\n', { afterRead: () => 'theirs\n' })
    useEditorStore.setState({ tabs: [{ path: 'a.md', name: 'a.md', content: null, frontmatter: '', editedContent: null, dirty: false, deleted: false }], activeTab: 'a.md' })
    await useEditorStore.getState().restoreSessionTabs()
    await editAndSave(`${tab().editedContent} edited`)
    const kept = server.disk.includes('theirs') || useSyncStore.getState().conflicts.some(c => c.theirs.includes('theirs'))
    expect(kept).toBe(true)
  })

  it('keeps the backend version for a note whose text cannot hash to it', async () => {
    backend('café\n', { lossy: true })
    await useEditorStore.getState().openFile('a.md', 'a.md')
    expect(tab().baseVersion).toBe(contentVersion('café\n'))
  })
})
