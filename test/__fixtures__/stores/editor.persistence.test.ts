import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEditorStore } from '../../../frontend/stores/editor'
import { useSyncStore } from '../../../frontend/stores/sync'
import { invoke } from '../../../frontend/lib/ipc'

vi.mock('../../../frontend/lib/ipc', () => ({
  invoke: vi.fn().mockResolvedValue(''),
  listen: vi.fn().mockResolvedValue(() => {}),
  IpcError: class IpcError extends Error { status?: number; constructor(message: string, status?: number) { super(message); this.status = status } },
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

/** Saves now go through the versioned guard, whose success shape is a JSON
 *  outcome. Default every mock write to "written" so the pre-existing
 *  assertions about *which* file was written stay meaningful. */
const written = (version = 'v') => JSON.stringify({ status: 'written', version })

/** Mirror the backend's guard in the mock: reject a write whose `baseVersion`
 *  no longer matches what the test says is on disk. */
function mockGuardedWrites() {
  const disk = new Map<string, string>()
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'write_file_checked') {
      const path = args?.path as string
      const base = (args?.baseVersion ?? null) as string | null
      const current = disk.get(path) ?? null
      if (base !== current) {
        return JSON.stringify({ status: 'conflict', disk: current ?? '', version: current ?? '' })
      }
      disk.set(path, `v${disk.size + 1}`)
      return written(`v${disk.size}`)
    }
    if (cmd === 'file_version') return disk.get(args?.path as string) ?? null
    return ''
  })
  return disk
}

describe('editor store tab persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(invoke).mockResolvedValue(written())
    useSyncStore.setState({ queue: [], conflicts: [], draining: false, attempts: 0, lastError: '' })
    useEditorStore.setState({ tabs: [], activeTab: null, _flushEditor: null, _aiWriting: false })
  })

  it('does not write unchanged files or auto-save when switching tabs', async () => {
    useEditorStore.setState({
      tabs: [
        { path: 'a.md', name: 'a.md', content: 'a', frontmatter: '', editedContent: null, dirty: false, deleted: false },
        { path: 'b.md', name: 'b.md', content: 'b', frontmatter: '', editedContent: null, dirty: false, deleted: false },
      ],
      activeTab: 'a.md',
    })

    await useEditorStore.getState().switchTab('b.md')
    await useEditorStore.getState().closeTab('b.md')

    expect(invoke).not.toHaveBeenCalledWith('write_file', expect.anything())
  })

  it('waits for editor settlement before detaching the active tab', async () => {
    let settle!: () => void
    const settled = new Promise<void>(resolve => { settle = resolve })
    useEditorStore.setState({
      tabs: [
        { path: 'a.md', name: 'a.md', content: 'old', frontmatter: '', editedContent: null, dirty: false, deleted: false },
        { path: 'b.md', name: 'b.md', content: 'b', frontmatter: '', editedContent: null, dirty: false, deleted: false },
      ],
      activeTab: 'a.md',
      _flushEditor: async () => {
        await settled
        useEditorStore.getState().setEditedContent('a.md', 'complete AI result')
        useEditorStore.getState().setTabDirty('a.md', true)
      },
    })

    const switching = useEditorStore.getState().switchTab('b.md')
    expect(useEditorStore.getState().activeTab).toBe('a.md')

    settle()
    await switching

    expect(useEditorStore.getState().activeTab).toBe('b.md')
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ editedContent: 'complete AI result', dirty: true })
  })

  it('keeps the active tab attached when serialization fails', async () => {
    useEditorStore.setState({
      tabs: [
        { path: 'a.md', name: 'a.md', content: 'old', frontmatter: '', editedContent: null, dirty: true, deleted: false },
        { path: 'b.md', name: 'b.md', content: 'b', frontmatter: '', editedContent: null, dirty: false, deleted: false },
      ],
      activeTab: 'a.md',
      _flushEditor: async () => { throw new Error('serialize failed') },
    })

    await useEditorStore.getState().switchTab('b.md')

    expect(useEditorStore.getState().activeTab).toBe('a.md')
  })

  it('writes a dirty active tab on close, including content edited to empty', async () => {
    useEditorStore.setState({
      tabs: [{ path: 'a.md', name: 'a.md', content: 'old', frontmatter: '', editedContent: '', dirty: true, deleted: false }],
      activeTab: 'a.md',
    })

    await useEditorStore.getState().closeTab('a.md')

    expect(invoke).toHaveBeenCalledWith('write_file_checked', { path: 'a.md', content: '', baseVersion: null })
  })

  it('keeps a dirty tab open and reports when its save fails', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('disk full'))
    useEditorStore.setState({
      tabs: [{ path: 'a.md', name: 'a.md', content: 'old', frontmatter: '', editedContent: 'changed', dirty: true, deleted: false }],
      activeTab: 'a.md',
    })

    await useEditorStore.getState().closeTab('a.md')

    expect(useEditorStore.getState().tabs).toHaveLength(1)
    expect(useEditorStore.getState().activeTab).toBe('a.md')
  })

  it('rejects persistAllDirty when any dirty file cannot be saved', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('disk full'))
    useEditorStore.setState({
      tabs: [{ path: 'a.md', name: 'a.md', content: 'old', frontmatter: '', editedContent: 'changed', dirty: true, deleted: false }],
      activeTab: 'a.md',
    })

    await expect(useEditorStore.getState().persistAllDirty()).rejects.toThrow('Could not save a.md')
  })

  it('does not save a dirty inactive tab when it is closed', async () => {
    useEditorStore.setState({
      tabs: [
        { path: 'a.md', name: 'a.md', content: 'old', frontmatter: '', editedContent: 'changed', dirty: true, deleted: false },
        { path: 'b.md', name: 'b.md', content: 'b', frontmatter: '', editedContent: null, dirty: false, deleted: false },
      ],
      activeTab: 'b.md',
    })

    await useEditorStore.getState().closeTab('a.md')

    expect(invoke).not.toHaveBeenCalledWith('write_file', expect.anything())
  })

  it('autosaves a dirty tab 2s after the last change (debounce, editable in both modes)', async () => {
    vi.useFakeTimers()
    try {
      useEditorStore.setState({
        tabs: [{ path: 'a.md', name: 'a.md', content: 'old', frontmatter: '', editedContent: 'new', dirty: false, deleted: false }],
        activeTab: 'a.md',
      })

      useEditorStore.getState().setTabDirty('a.md', true)
      expect(invoke).not.toHaveBeenCalledWith('write_file', expect.anything())
      await vi.advanceTimersByTimeAsync(1999)
      expect(invoke).not.toHaveBeenCalledWith('write_file', expect.anything())
      await vi.advanceTimersByTimeAsync(1)

      expect(invoke).toHaveBeenCalledWith('write_file_checked', { path: 'a.md', content: 'new', baseVersion: null })
      const tab = useEditorStore.getState().tabs[0]
      expect(tab.dirty).toBe(false)
      expect(tab.content).toBe('new') // baseline rebased to the written file
    } finally { vi.useRealTimers() }
  })

  it('holds autosave while the AI is writing (guard 2), then saves after it ends', async () => {
    vi.useFakeTimers()
    try {
      useEditorStore.setState({
        tabs: [{ path: 'a.md', name: 'a.md', content: 'old', frontmatter: '', editedContent: 'ai result', dirty: false, deleted: false }],
        activeTab: 'a.md',
        _aiWriting: true,
      })

      useEditorStore.getState().setTabDirty('a.md', true)
      await vi.advanceTimersByTimeAsync(5000)
      expect(invoke).not.toHaveBeenCalledWith('write_file', expect.anything())

      // AI ends → WysiwygEditor re-sets dirty → a fresh autosave writes the full result
      useEditorStore.getState().setAiWriting(false)
      useEditorStore.getState().setTabDirty('a.md', true)
      await vi.advanceTimersByTimeAsync(2000)

      expect(invoke).toHaveBeenCalledWith('write_file_checked', { path: 'a.md', content: 'ai result', baseVersion: null })
    } finally { vi.useRealTimers() }
  })

  it('keeps a restored tab when reading it fails for a non-missing-file reason', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('permission denied'))
    useEditorStore.setState({
      tabs: [{ path: 'a.md', name: 'a.md', content: null, frontmatter: '', editedContent: null, dirty: false, deleted: false }],
      activeTab: 'a.md',
    })

    await useEditorStore.getState().restoreSessionTabs()

    expect(useEditorStore.getState().tabs).toHaveLength(1)
    expect(useEditorStore.getState().activeTab).toBe('a.md')
  })

  it('closes a restored tab when its file is missing', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('No such file or directory'))
    useEditorStore.setState({
      tabs: [{ path: 'a.md', name: 'a.md', content: null, frontmatter: '', editedContent: null, dirty: false, deleted: false }],
      activeTab: 'a.md',
    })

    await useEditorStore.getState().restoreSessionTabs()

    expect(useEditorStore.getState().tabs).toHaveLength(0)
    expect(useEditorStore.getState().activeTab).toBeNull()
  })

  it('does not rewrite a file whose content matches the disk baseline (guard 1)', async () => {
    useEditorStore.setState({
      tabs: [{ path: 'a.md', name: 'a.md', content: 'same', frontmatter: '', editedContent: 'same', dirty: true, deleted: false }],
      activeTab: 'a.md',
    })

    await useEditorStore.getState().closeTab('a.md')

    expect(invoke).not.toHaveBeenCalledWith('write_file_checked', expect.anything())
  })

  /** The point of the whole sync layer: a save must never silently overwrite a
   *  change that landed on disk after this tab was opened. */
  it('surfaces a conflict instead of overwriting when disk changed underneath the edit', async () => {
    mockGuardedWrites()
    useEditorStore.setState({
      tabs: [{ path: 'a.md', name: 'a.md', content: 'v1', frontmatter: '', editedContent: 'v2', dirty: true, deleted: false, baseVersion: 'stale' }],
      activeTab: 'a.md',
    })

    await useEditorStore.getState().persistAllDirty()

    const { conflicts } = useSyncStore.getState()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ path: 'a.md', mine: 'v2' })
    // The local edit is preserved and the tab keeps it, so nothing is lost by
    // refusing the write.
    expect(useEditorStore.getState().tabs[0].editedContent).toBe('v2')
    expect(useEditorStore.getState().tabs[0].dirty).toBe(true)
  })

  it('queues the write durably when the backend is unreachable', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('Cannot reach server'))
    useEditorStore.setState({
      tabs: [{ path: 'a.md', name: 'a.md', content: 'v1', frontmatter: '', editedContent: 'v2', dirty: true, deleted: false, baseVersion: 'v1' }],
      activeTab: 'a.md',
    })

    await useEditorStore.getState().persistAllDirty()

    const { queue } = useSyncStore.getState()
    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({ path: 'a.md', content: 'v2', baseVersion: 'v1' })
    // The edit now lives in the durable queue, so the tab is no longer dirty —
    // leaving it dirty would re-enqueue the same write on every autosave tick.
    expect(useEditorStore.getState().tabs[0].dirty).toBe(false)
    expect(useEditorStore.getState().tabs[0].content).toBe('v2')
  })

  it('does not queue a permanent failure — it reports it to the caller', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('Permission denied'))
    useEditorStore.setState({
      tabs: [{ path: 'a.md', name: 'a.md', content: 'v1', frontmatter: '', editedContent: 'v2', dirty: true, deleted: false }],
      activeTab: 'a.md',
    })

    await expect(useEditorStore.getState().persistAllDirty()).rejects.toThrow('Could not save a.md')
    expect(useSyncStore.getState().queue).toHaveLength(0)
  })

  it('re-bases the tab baseline to the version returned by the write', async () => {
    mockGuardedWrites()
    useEditorStore.setState({
      tabs: [{ path: 'a.md', name: 'a.md', content: 'v1', frontmatter: '', editedContent: 'v2', dirty: true, deleted: false, baseVersion: null }],
      activeTab: 'a.md',
    })

    await useEditorStore.getState().persistAllDirty()

    // Without the re-base, every subsequent save would look stale.
    expect(useEditorStore.getState().tabs[0].baseVersion).toBeTruthy()
    expect(useEditorStore.getState().tabs[0].dirty).toBe(false)
  })


  it('adopts the disk version and drops the local edit when the user picks theirs', async () => {
    useSyncStore.setState({
      conflicts: [{ id: 'conflict-a', path: 'a.md', mine: 'mine', theirs: 'theirs', theirsVersion: 'v9', baseContent: null, detectedAt: 0 }],
      queue: [], draining: false, attempts: 0, lastError: '',
    })

    await useEditorStore.getState().applyConflictTheirs('a.md')

    expect(useSyncStore.getState().conflicts).toHaveLength(0)
    // No write should happen: disk already holds the winning content.
    expect(invoke).not.toHaveBeenCalledWith('write_file_checked', expect.anything())
  })
})
