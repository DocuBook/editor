import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useSyncStore, contentVersion, isRetryableError, conflictCopyPath, persistedSyncState } from '../../../frontend/stores/sync'
import { invoke } from '../../../frontend/lib/ipc'

vi.mock('../../../frontend/lib/ipc', () => ({
  invoke: vi.fn().mockResolvedValue(''),
  IpcError: class IpcError extends Error { status?: number; constructor(message: string, status?: number) { super(message); this.status = status } },
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const written = (version = 'v1') => JSON.stringify({ status: 'written', version })
const conflicted = (disk: string, version: string, reason: 'target_exists' | 'version_mismatch' = 'version_mismatch') => JSON.stringify({ status: 'conflict', disk, version, reason })

describe('contentVersion', () => {
  it('is stable for equal content and differs for any change', () => {
    expect(contentVersion('hello')).toBe(contentVersion('hello'))
    expect(contentVersion('hello')).not.toBe(contentVersion('hello '))
    expect(contentVersion('')).not.toBe(contentVersion('a'))
  })

  /** The hash must be byte-compatible with the Rust `content_version`, or every
   *  checked write would be rejected as stale. These exact values are pinned in
   *  the Rust suite too (`cross_runtime_hash_parity`), so drift on either side
   *  fails a test rather than breaking saves at runtime. */
  it('matches the Rust implementation for known inputs', () => {
    expect(contentVersion('')).toBe('cbf29ce484222325')
    expect(contentVersion('a')).toBe('af63dc4c8601ec8c')
    expect(contentVersion('hello')).toBe('a430d84680aabd0b')
    expect(contentVersion('hello world')).toBe('779a65e7023cd2e7')
    // Multi-byte UTF-8 must hash over bytes, not code units: Rust hashes the
    // UTF-8 byte sequence, so the encoder here has to produce the same bytes.
    expect(contentVersion('# Title\n\nbody with émoji 🎉')).toBe('92709619a2fcf94b')
  })

  it('handles content longer than one JS-safe integer without precision loss', () => {
    const long = 'x'.repeat(50_000)
    expect(contentVersion(long)).toBe(contentVersion(long))
    expect(contentVersion(long)).not.toBe(contentVersion(`${long}y`))
  })
})

describe('conflictCopyPath', () => {
  it('inserts the marker before the extension and keeps the folder', () => {
    expect(conflictCopyPath('notes/plan.md')).toBe('notes/plan (conflicted copy).md')
    expect(conflictCopyPath('README.md')).toBe('README (conflicted copy).md')
  })

  it('does not treat a leading dot as an extension', () => {
    expect(conflictCopyPath('.gitignore')).toBe('.gitignore (conflicted copy)')
  })

  it('appends when there is no extension', () => {
    expect(conflictCopyPath('notes/plain')).toBe('notes/plain (conflicted copy)')
  })
})

describe('isRetryableError', () => {
  it('treats transport and closed-vault failures as retryable', () => {
    expect(isRetryableError(new Error('Cannot reach server'))).toBe(true)
    expect(isRetryableError(new Error('Server is not responding'))).toBe(true)
    expect(isRetryableError(new Error('No vault'))).toBe(true)
    expect(isRetryableError(new Error('Failed to fetch'))).toBe(true)
  })

  it('treats permanent failures as fatal so they cannot loop forever', () => {
    expect(isRetryableError(new Error('Permission denied'))).toBe(false)
    expect(isRetryableError(new Error('Invalid path'))).toBe(false)
  })

})

const reset = () => useSyncStore.setState({
  queue: [], conflicts: [], draining: false, attempts: 0, lastError: '',
})

describe('sync store queue and drain', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(invoke).mockResolvedValue('')
    reset()
  })

  it('enqueues a write with a content hash and a monotonic sequence', () => {
    const { enqueue } = useSyncStore.getState()
    enqueue({ path: 'a.md', content: 'one', baseVersion: null })
    enqueue({ path: 'b.md', content: 'two', baseVersion: 'v0' })

    const { queue } = useSyncStore.getState()
    expect(queue).toHaveLength(2)
    expect(queue[1].seq).toBeGreaterThan(queue[0].seq)
    expect(queue[0].contentVersion).toBe(contentVersion('one'))
  })

  it('supersedes an earlier queued write for the same path', () => {
    const { enqueue } = useSyncStore.getState()
    enqueue({ path: 'a.md', content: 'draft 1', baseVersion: null })
    enqueue({ path: 'a.md', content: 'draft 2', baseVersion: null })

    const { queue } = useSyncStore.getState()
    expect(queue).toHaveLength(1)
    expect(queue[0].content).toBe('draft 2')
  })

  it('drains the queue on the success path and clears it', async () => {
    vi.mocked(invoke).mockResolvedValue(written())
    useSyncStore.getState().enqueue({ path: 'a.md', content: 'one', baseVersion: null })

    await useSyncStore.getState().drain()

    expect(invoke).toHaveBeenCalledWith('write_file_checked', { path: 'a.md', content: 'one', baseVersion: null })
    expect(useSyncStore.getState().queue).toHaveLength(0)
    expect(useSyncStore.getState().attempts).toBe(0)
  })

  it('keeps the write queued when the backend is still unreachable', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('Cannot reach server'))
    useSyncStore.getState().enqueue({ path: 'a.md', content: 'one', baseVersion: null })

    await useSyncStore.getState().drain()

    // Still queued: the edit is not lost, it is waiting.
    expect(useSyncStore.getState().queue).toHaveLength(1)
    expect(useSyncStore.getState().attempts).toBeGreaterThan(0)
    expect(useSyncStore.getState().lastError).toBeTruthy()

    // The retry timer this scheduled must not leak into other tests.
    useSyncStore.getState().discard('a.md')
  })

  it('turns a conflicting queued write into a conflict record', async () => {
    vi.mocked(invoke).mockResolvedValue(conflicted('disk text', 'v9'))
    useSyncStore.getState().enqueue({ path: 'a.md', content: 'mine', baseVersion: 'stale' })

    await useSyncStore.getState().drain()

    const { conflicts, queue } = useSyncStore.getState()
    expect(queue).toHaveLength(0)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ path: 'a.md', mine: 'mine', theirs: 'disk text', theirsVersion: 'v9' })
  })

  it('does not run two drains concurrently', async () => {
    let resolveWrite!: (v: string) => void
    vi.mocked(invoke).mockReturnValue(new Promise<string>(r => { resolveWrite = r }) as Promise<never>)
    useSyncStore.getState().enqueue({ path: 'a.md', content: 'one', baseVersion: null })

    const first = useSyncStore.getState().drain()
    await useSyncStore.getState().drain() // returns immediately: draining flag set
    expect(invoke).toHaveBeenCalledTimes(1)

    resolveWrite(written())
    await first
  })


  it('resolves keep-mine with a UUID companion after the readable name is occupied', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'test-id' })
    vi.mocked(invoke)
      .mockResolvedValueOnce(conflicted('existing', 'v1', 'target_exists'))
      .mockResolvedValueOnce(written('v2'))
    useSyncStore.setState({
      conflicts: [{ id: 'conflict-a', path: 'a.md', mine: 'mine', theirs: 'theirs', theirsVersion: 'v9', baseContent: null, detectedAt: 0 }],
      queue: [], draining: false, attempts: 0, lastError: '',
    })

    await expect(useSyncStore.getState().resolveKeepBoth('a.md')).resolves.toBe('a (conflicted copy test-id).md')
    expect(invoke).toHaveBeenNthCalledWith(2, 'write_file_checked', {
      path: 'a (conflicted copy test-id).md', content: 'mine', baseVersion: null,
    })
    vi.unstubAllGlobals()
  })

  it('keeps the conflict when both keep-both names are occupied', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'test-id' })
    vi.mocked(invoke).mockResolvedValue(conflicted('existing', 'v1', 'target_exists'))
    useSyncStore.setState({
      conflicts: [{ id: 'conflict-a', path: 'a.md', mine: 'mine', theirs: 'theirs', theirsVersion: 'v9', baseContent: null, detectedAt: 0 }],
      queue: [], draining: false, attempts: 0, lastError: '',
    })

    await expect(useSyncStore.getState().resolveKeepBoth('a.md')).rejects.toThrow('both candidate names are occupied')
    expect(useSyncStore.getState().conflicts).toHaveLength(1)
    vi.unstubAllGlobals()
  })

  it('resolves keep-mine by re-basing on the current disk version', async () => {
    vi.mocked(invoke).mockResolvedValue(written('v10'))
    useSyncStore.setState({
      conflicts: [{ id: 'conflict-a', path: 'a.md', mine: 'mine', theirs: 'theirs', theirsVersion: 'v9', baseContent: null, detectedAt: 0 }],
      queue: [], draining: false, attempts: 0, lastError: '',
    })

    await useSyncStore.getState().resolveKeepMine('a.md')

    expect(invoke).toHaveBeenCalledWith('write_file_checked', { path: 'a.md', content: 'mine', baseVersion: 'v9' })
    expect(useSyncStore.getState().conflicts).toHaveLength(0)
  })

  it('keeps the conflict open when the file changes again mid-resolution', async () => {
    vi.mocked(invoke).mockResolvedValue(conflicted('third party text', 'v11'))
    useSyncStore.setState({
      conflicts: [{ id: 'conflict-a', path: 'a.md', mine: 'mine', theirs: 'theirs', theirsVersion: 'v9', baseContent: null, detectedAt: 0 }],
      queue: [], draining: false, attempts: 0, lastError: '',
    })

    await useSyncStore.getState().resolveKeepMine('a.md')

    // Not dropped, and refreshed to the newest disk state so the next decision
    // is made against what is actually there.
    const { conflicts } = useSyncStore.getState()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].theirs).toBe('third party text')
    expect(conflicts[0].theirsVersion).toBe('v11')
  })

  it('keeps only one conflict per path', () => {
    const { addConflict } = useSyncStore.getState()
    addConflict({ path: 'a.md', mine: 'm1', theirs: 't1', theirsVersion: 'v1', baseContent: null })
    addConflict({ path: 'a.md', mine: 'm2', theirs: 't2', theirsVersion: 'v2', baseContent: null })

    const { conflicts } = useSyncStore.getState()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].mine).toBe('m2')
  })

  it('exposes hasConflict and pendingCount for the UI', () => {
    useSyncStore.getState().enqueue({ path: 'a.md', content: 'x', baseVersion: null })
    useSyncStore.getState().addConflict({ path: 'b.md', mine: 'm', theirs: 't', theirsVersion: 'v', baseContent: null })

    expect(useSyncStore.getState().pendingCount()).toBe(1)
    expect(useSyncStore.getState().hasConflict('b.md')).toBe(true)
    expect(useSyncStore.getState().hasConflict('a.md')).toBe(false)
  })

  it('discard drops both a queued write and its conflict', () => {
    useSyncStore.getState().enqueue({ path: 'a.md', content: 'x', baseVersion: null })
    useSyncStore.getState().addConflict({ path: 'a.md', mine: 'm', theirs: 't', theirsVersion: 'v', baseContent: null })

    useSyncStore.getState().discard('a.md')

    expect(useSyncStore.getState().queue).toHaveLength(0)
    expect(useSyncStore.getState().conflicts).toHaveLength(0)
  })

  it('retains a permanently-failing queued write as an actionable failure' , async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('Permission denied'))
    useSyncStore.getState().enqueue({ path: 'a.md', content: 'precious', baseVersion: null })

    await useSyncStore.getState().drain()

    const { queue, conflicts, failures } = useSyncStore.getState()
    expect(queue).toHaveLength(0)
    expect(conflicts).toHaveLength(0)
    expect(failures[0].content).toBe('precious')
  })
})

describe('sync store persistence', () => {
  afterEach(() => reset())

  /** The durable half of "durable queue": queue and conflicts must survive a
   *  reload, and the transient drain flags must NOT — a persisted
   *  `draining: true` would reload a store that refuses to ever drain again. */
  it('persists queue and conflicts but never the transient drain flags', () => {
    // Reset explicitly: the projection is read from live store state, so a
    // leftover conflict from an earlier case would make this ambiguous.
    reset()
    useSyncStore.getState().enqueue({ path: 'a.md', content: 'one', baseVersion: null })
    useSyncStore.getState().addConflict({ path: 'b.md', mine: 'm', theirs: 't', theirsVersion: 'v', baseContent: null })
    useSyncStore.setState({ draining: true, attempts: 3, lastError: 'waiting' })

    const projected = persistedSyncState(useSyncStore.getState()) as Record<string, unknown>

    expect(projected.queue).toHaveLength(1)
    expect(projected.conflicts).toHaveLength(1)
    expect(projected).not.toHaveProperty('draining')
    expect(projected).not.toHaveProperty('attempts')
    expect(projected).not.toHaveProperty('lastError')
  })
})
