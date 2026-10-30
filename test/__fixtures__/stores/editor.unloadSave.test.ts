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

/** A tab whose WYSIWYG edit is still only in the editor: the flush hands it to
 *  the store, as the real editor's flush does. */
function dirtyTab() {
  useEditorStore.setState({
    tabs: [{ path: 'a.md', name: 'a.md', content: 'old\n', frontmatter: '', editedContent: 'old', dirty: true, deleted: false, baseVersion: 'v0' }],
    activeTab: 'a.md',
    _flushEditor: () => useEditorStore.getState().setEditedContent('a.md', 'typed just now'),
  })
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('saving when the browser tab goes away', () => {
  let uninstall: () => void
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(invoke).mockResolvedValue(JSON.stringify({ status: 'written', version: 'v1' }))
    useSyncStore.getState().reset()
    useEditorStore.setState({ tabs: [], activeTab: null, _flushEditor: null })
    uninstall = installUnloadSave()
  })
  afterEach(() => {
    uninstall()
    setVisibility('visible')
  })

  it('saves pending edits when the page is hidden', async () => {
    dirtyTab()
    setVisibility('hidden')
    await vi.waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0][1]).toMatchObject({ path: 'a.md', content: 'typed just now\n' })
  })

  it('saves and asks to confirm leaving while a tab is dirty', async () => {
    dirtyTab()
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(writes()).toHaveLength(1))
  })

  it('writes once when one page exit fires every unload event', async () => {
    dirtyTab()
    window.dispatchEvent(new Event('beforeunload', { cancelable: true }))
    window.dispatchEvent(new Event('pagehide'))
    setVisibility('hidden')
    await vi.waitFor(() => expect(useEditorStore.getState().tabs[0].dirty).toBe(false))
    await useEditorStore.getState().persistAllDirty()
    expect(writes()).toHaveLength(1)
  })

  it('does not resend a write still in flight when the page is hidden', async () => {
    let land!: (raw: string) => void
    vi.mocked(invoke).mockImplementationOnce(() => new Promise(resolve => { land = resolve }))
    dirtyTab()
    const autosave = useEditorStore.getState().persistAllDirty()
    await vi.waitFor(() => expect(writes()).toHaveLength(1))
    setVisibility('hidden')
    // Give the hide's save every chance to start before the first write lands.
    await new Promise(resolve => setTimeout(resolve, 0))
    land(JSON.stringify({ status: 'written', version: 'v1' }))
    await autosave
    await useEditorStore.getState().persistAllDirty()
    expect(writes()).toHaveLength(1)
    expect(useSyncStore.getState().conflicts).toHaveLength(0)
  })

  it('lets the page go without a prompt or a write when nothing is pending', () => {
    useEditorStore.setState({
      tabs: [{ path: 'a.md', name: 'a.md', content: 'old\n', frontmatter: '', editedContent: 'old', dirty: false, deleted: false }],
      activeTab: 'a.md',
    })
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    setVisibility('hidden')
    expect(event.defaultPrevented).toBe(false)
    expect(writes()).toHaveLength(0)
  })

  it('stops listening once uninstalled', () => {
    uninstall()
    dirtyTab()
    setVisibility('hidden')
    expect(writes()).toHaveLength(0)
    uninstall = () => {}
  })
})
