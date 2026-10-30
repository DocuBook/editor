import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useEditorStore } from '../../../frontend/stores/editor'
import { useSyncStore, contentVersion } from '../../../frontend/stores/sync'
import { invoke } from '../../../frontend/lib/ipc'

vi.mock('../../../frontend/lib/ipc', () => ({
  invoke: vi.fn(),
  listen: vi.fn().mockResolvedValue(() => {}),
  IpcError: class IpcError extends Error { status?: number; constructor(message: string, status?: number) { super(message); this.status = status } },
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

/** A backend with one file whose guard behaves like `write_file_checked`.
 *  `down` makes every write fail the way an unreachable server does; `hold`
 *  parks the next write until the test releases it (a write in flight). */
function backend(initial: string) {
  const state = { disk: initial, down: true, writes: [] as string[], hold: null as null | (() => void) }
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd !== 'write_file_checked') return ''
    if (state.down) throw new Error('Cannot reach server')
    if (state.hold) {
      const release = new Promise<void>(resolve => { state.hold = resolve })
      await release
    }
    const content = args?.content as string
    if (args?.baseVersion !== contentVersion(state.disk)) {
      return JSON.stringify({ status: 'conflict', disk: state.disk, version: contentVersion(state.disk), reason: 'version_mismatch' })
    }
    state.disk = content
    state.writes.push(content)
    return JSON.stringify({ status: 'written', version: contentVersion(content) })
  })
  return state
}

function openTab(content: string, edited: string) {
  useEditorStore.setState({
    tabs: [{ path: 'a.md', name: 'a.md', content, frontmatter: '', editedContent: edited, dirty: true, deleted: false, baseVersion: contentVersion(content) }],
    activeTab: 'a.md',
    _flushEditor: null,
  })
}

/** Type into the open tab and let its autosave fire. */
async function type(text: string) {
  useEditorStore.getState().setEditedContent('a.md', text)
  useEditorStore.getState().setTabDirty('a.md', true)
  await vi.advanceTimersByTimeAsync(2_500)
}

describe('offline queue hand-off to live saves', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    useSyncStore.getState().reset()
  })
  afterEach(() => {
    useSyncStore.getState().reset()
    vi.useRealTimers()
  })

  it('drains a queued write once the backend is back, without an online event', async () => {
    const server = backend('v0\n')
    openTab('v0\n', 'A')
    await useEditorStore.getState().persistAllDirty()
    expect(useSyncStore.getState().queue).toHaveLength(1)

    server.down = false
    await vi.advanceTimersByTimeAsync(60_000)

    expect(useSyncStore.getState().queue).toHaveLength(0)
    expect(server.disk).toBe('A\n')
    expect(useSyncStore.getState().conflicts).toHaveLength(0)
  })

  it('an edit made on top of a queued write lands after it instead of conflicting with it', async () => {
    const server = backend('v0\n')
    openTab('v0\n', 'A')
    await useEditorStore.getState().persistAllDirty()
    server.down = false

    // The user keeps typing before the queue had a chance to drain.
    await type('A B')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(useSyncStore.getState().conflicts).toHaveLength(0)
    expect(useSyncStore.getState().queue).toHaveLength(0)
    expect(server.disk).toBe('A B\n')
    // The tab is rebased on what landed, so the next edit is a plain write.
    await type('A B C')
    expect(server.disk).toBe('A B C\n')
    expect(useSyncStore.getState().conflicts).toHaveLength(0)
  })

  it('rebases the follow-up edit when its predecessor was already in flight', async () => {
    const server = backend('v0\n')
    openTab('v0\n', 'A')
    await useEditorStore.getState().persistAllDirty()
    server.down = false
    server.hold = () => {}

    // The queued write is sent and parked mid-flight.
    const draining = useSyncStore.getState().drain()
    await vi.advanceTimersByTimeAsync(0)
    await type('A B')
    server.hold?.()
    server.hold = null
    await draining
    await vi.advanceTimersByTimeAsync(60_000)

    expect(server.writes).toEqual(['A\n', 'A B\n'])
    expect(useSyncStore.getState().conflicts).toHaveLength(0)
    expect(useSyncStore.getState().queue).toHaveLength(0)
  })

  it('rebases a chain of follow-up edits made while the predecessor was in flight', async () => {
    const server = backend('v0\n')
    openTab('v0\n', 'A')
    await useEditorStore.getState().persistAllDirty()
    server.down = false
    server.hold = () => {}

    const draining = useSyncStore.getState().drain()
    await vi.advanceTimersByTimeAsync(0)
    // Two autosaves pile up behind the parked write; the second supersedes the first.
    await type('A B')
    await type('A B C')
    server.hold?.()
    server.hold = null
    await draining
    await vi.advanceTimersByTimeAsync(60_000)

    expect(server.writes).toEqual(['A\n', 'A B C\n'])
    expect(useSyncStore.getState().conflicts).toHaveLength(0)
    expect(useSyncStore.getState().queue).toHaveLength(0)
  })

  it('waits on the sent follow-up, not on the predecessor it superseded', async () => {
    const server = backend('v0\n')
    openTab('v0\n', 'A')
    await useEditorStore.getState().persistAllDirty()
    // Still offline: the follow-up supersedes `A`, which is never sent.
    await type('A B')
    server.down = false
    server.hold = () => {}

    const draining = useSyncStore.getState().drain()
    await vi.advanceTimersByTimeAsync(0)
    await type('A B C')
    server.hold?.()
    server.hold = null
    await draining
    await vi.advanceTimersByTimeAsync(60_000)

    expect(server.writes).toEqual(['A B\n', 'A B C\n'])
    expect(useSyncStore.getState().conflicts).toHaveLength(0)
    expect(useSyncStore.getState().queue).toHaveLength(0)
  })

  it('an edit that does not continue the queued write still keeps both sides', async () => {
    const server = backend('v0\n')
    openTab('v0\n', 'A')
    await useEditorStore.getState().persistAllDirty()
    server.down = false

    // The tab was reopened from disk, so it no longer shows the queued text:
    // its edit is not a continuation of that write and must not replace it.
    useEditorStore.getState().setContent('a.md', 'v0\n')
    useEditorStore.setState({ tabs: useEditorStore.getState().tabs.map(t => ({ ...t, baseVersion: contentVersion('v0\n') })) })
    await type('C')
    await vi.advanceTimersByTimeAsync(60_000)

    // Whichever write lands first, the other one is a conflict: neither text
    // is dropped or silently replaced.
    const conflicts = useSyncStore.getState().conflicts
    expect(conflicts).toHaveLength(1)
    expect([server.disk, conflicts[0].mine].sort()).toEqual(['A\n', 'C\n'])
    expect(conflicts[0].theirs).toBe(server.disk)
  })
})
