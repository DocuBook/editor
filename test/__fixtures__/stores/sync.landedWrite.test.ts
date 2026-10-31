import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useEditorStore } from '../../../frontend/stores/editor'
import { useSyncStore, contentVersion, parseWriteOutcome } from '../../../frontend/stores/sync'
import { invoke } from '../../../frontend/lib/ipc'

vi.mock('../../../frontend/lib/ipc', () => ({
  invoke: vi.fn(),
  listen: vi.fn().mockResolvedValue(() => {}),
  IpcError: class IpcError extends Error { status?: number; constructor(message: string, status?: number) { super(message); this.status = status } },
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

/** A backend with one file and the `write_file_checked` guard. `loseNextReply`
 *  applies the next write but fails its reply the way an aborted fetch does —
 *  the page that sent a keepalive save on its way out never sees the answer. */
function backend(initial: string) {
  const state = { disk: initial, loseNextReply: false, writes: 0 }
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd !== 'write_file_checked') return ''
    const content = args?.content as string
    if (args?.baseVersion !== contentVersion(state.disk)) {
      return JSON.stringify({ status: 'conflict', disk: state.disk, version: contentVersion(state.disk), reason: 'version_mismatch' })
    }
    state.disk = content
    state.writes++
    if (state.loseNextReply) {
      state.loseNextReply = false
      throw new Error('Cannot reach server')
    }
    return JSON.stringify({ status: 'written', version: contentVersion(content) })
  })
  return state
}

function openTab(content: string, edited: string, baseVersion = contentVersion(content)) {
  useEditorStore.setState({
    tabs: [{ path: 'a.md', name: 'a.md', content, frontmatter: '', editedContent: edited, dirty: true, deleted: false, baseVersion }],
    activeTab: 'a.md',
    _flushEditor: null,
  })
}

describe('a write that already landed is not a conflict', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    useSyncStore.getState().reset()
  })
  afterEach(() => {
    useSyncStore.getState().reset()
    vi.useRealTimers()
  })

  it('replaying a queued write whose reply was lost leaves no conflict', async () => {
    const server = backend('v0\n')
    server.loseNextReply = true
    openTab('v0\n', 'typed before reload')

    // The request lands, but the page sees it fail and queues it.
    await useEditorStore.getState().persistAllDirty()
    expect(server.disk).toBe('typed before reload\n')
    expect(useSyncStore.getState().queue).toHaveLength(1)

    // The replay carries the old baseline; disk already holds its content.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(useSyncStore.getState().conflicts).toHaveLength(0)
    expect(useSyncStore.getState().queue).toHaveLength(0)
    expect(server.writes).toBe(1)

    // The tab continues from what is on disk: the next edit is a plain write.
    useEditorStore.getState().setEditedContent('a.md', 'typed before reload, then more')
    useEditorStore.getState().setTabDirty('a.md', true)
    await vi.advanceTimersByTimeAsync(2_500)
    expect(server.disk).toBe('typed before reload, then more\n')
    expect(useSyncStore.getState().conflicts).toHaveLength(0)
  })

  it('a direct save whose text is already on disk settles the tab on that version', async () => {
    const server = backend('same text\n')
    // The tab's baseline is stale, but disk already holds exactly its edit.
    openTab('old\n', 'same text', contentVersion('old\n'))
    await useEditorStore.getState().persistAllDirty()

    expect(useSyncStore.getState().conflicts).toHaveLength(0)
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ dirty: false, baseVersion: contentVersion('same text\n') })
    expect(server.writes).toBe(0)
  })

  it('still reports a real conflict when disk holds different text', async () => {
    backend('theirs\n')
    openTab('old\n', 'mine', contentVersion('old\n'))
    await useEditorStore.getState().persistAllDirty()

    expect(useSyncStore.getState().conflicts).toHaveLength(1)
    expect(useSyncStore.getState().conflicts[0]).toMatchObject({ mine: 'mine\n', theirs: 'theirs\n' })
  })

  it('"Keep mine" counts as resolved when disk already holds my text', async () => {
    backend('mine\n')
    useSyncStore.getState().addConflict({ path: 'a.md', mine: 'mine\n', theirs: 'theirs\n', theirsVersion: contentVersion('theirs\n'), baseContent: null })
    await expect(useSyncStore.getState().resolveKeepMine('a.md')).resolves.toBe(true)
    expect(useSyncStore.getState().conflicts).toHaveLength(0)
  })
})

describe('parseWriteOutcome', () => {
  it('keeps a conflict against a vanished file, whose empty version matches nothing', () => {
    const raw = JSON.stringify({ status: 'conflict', disk: '', version: '', reason: 'version_mismatch' })
    expect(parseWriteOutcome(raw, '').status).toBe('conflict')
  })

  it('reads a target_exists rejection holding the same bytes as written', () => {
    const raw = JSON.stringify({ status: 'conflict', disk: 'x\n', version: contentVersion('x\n'), reason: 'target_exists' })
    expect(parseWriteOutcome(raw, 'x\n')).toEqual({ status: 'written', version: contentVersion('x\n') })
  })
})
