import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEditorStore } from '../../../frontend/stores/editor'
import { useSyncStore } from '../../../frontend/stores/sync'
import { invoke } from '../../../frontend/lib/ipc'
import { splitFrontmatter } from '../../../frontend/utils/frontmatter'
import { clearEditorCache, getEditorCache, peekEditorCache } from '../../../frontend/utils/editorCache'

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
    clearEditorCache()
    vi.clearAllMocks()
    vi.mocked(invoke).mockResolvedValue(written())
    useSyncStore.setState({ queue: [], conflicts: [], draining: false, attempts: 0, lastError: '' })
    useEditorStore.setState({ tabs: [], activeTab: null, _flushEditor: null })
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
    const abort = vi.fn()
    getEditorCache('vault', () => ({ editor: { getExtension: () => ({ abort }) } })).get('a.md')
    vi.mocked(invoke).mockRejectedValueOnce(new Error('disk full'))
    useEditorStore.setState({
      tabs: [{ path: 'a.md', name: 'a.md', content: 'old', frontmatter: '', editedContent: 'changed', dirty: true, deleted: false }],
      activeTab: 'a.md',
    })

    await useEditorStore.getState().closeTab('a.md')

    expect(useEditorStore.getState().tabs).toHaveLength(1)
    expect(useEditorStore.getState().activeTab).toBe('a.md')
    expect(abort).not.toHaveBeenCalled()
  })

  it('rejects persistAllDirty when any dirty file cannot be saved', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('disk full'))
    useEditorStore.setState({
      tabs: [{ path: 'a.md', name: 'a.md', content: 'old', frontmatter: '', editedContent: 'changed', dirty: true, deleted: false }],
      activeTab: 'a.md',
    })

    await expect(useEditorStore.getState().persistAllDirty()).rejects.toThrow('Could not save a.md')
  })

  it('aborts and releases only the editor for the tab that is actually closed', async () => {
    const abortA = vi.fn()
    const abortB = vi.fn()
    getEditorCache('vault', path => ({ editor: { getExtension: () => ({ abort: path === 'a.md' ? abortA : abortB }) } }))
      .get('a.md')
    getEditorCache('vault', path => ({ editor: { getExtension: () => ({ abort: path === 'a.md' ? abortA : abortB }) } }))
      .get('b.md')
    useEditorStore.setState({
      tabs: [
        { path: 'a.md', name: 'a.md', content: 'a', frontmatter: '', editedContent: null, dirty: false, deleted: false },
        { path: 'b.md', name: 'b.md', content: 'b', frontmatter: '', editedContent: null, dirty: false, deleted: false },
      ],
      activeTab: 'b.md',
    })

    await useEditorStore.getState().closeTab('a.md')

    expect(abortA).toHaveBeenCalledWith('tab closed')
    expect(abortB).not.toHaveBeenCalled()
    expect(peekEditorCache('vault', 'a.md')).toBeNull()
    expect(peekEditorCache('vault', 'b.md')).not.toBeNull()
  })

  it('aborts every cached page when all tabs are closed', () => {
    const abortA = vi.fn()
    const abortB = vi.fn()
    const create = (path: string) => ({ editor: { getExtension: () => ({ abort: path === 'a.md' ? abortA : abortB }) } })
    const cache = getEditorCache('vault', create)
    cache.get('a.md')
    cache.get('b.md')

    useEditorStore.getState().closeAllTabs()

    expect(abortA).toHaveBeenCalledWith('vault closed')
    expect(abortB).toHaveBeenCalledWith('vault closed')
  })

  it('does not abort page AI when switching tabs', async () => {
    const abort = vi.fn()
    getEditorCache('vault', () => ({ editor: { getExtension: () => ({ abort }) } })).get('a.md')
    useEditorStore.setState({
      tabs: [
        { path: 'a.md', name: 'a.md', content: 'a', frontmatter: '', editedContent: null, dirty: false, deleted: false },
        { path: 'b.md', name: 'b.md', content: 'b', frontmatter: '', editedContent: null, dirty: false, deleted: false },
      ],
      activeTab: 'a.md',
    })

    await useEditorStore.getState().switchTab('b.md')

    expect(abort).not.toHaveBeenCalled()
  })

  /** Switching away flushes a tab and leaves its autosave pending; closing it
   *  from the strip before that fires cancels the autosave, so the close must
   *  save it — otherwise the edit is silently dropped. */
  it('saves a dirty inactive tab before closing it', async () => {
    useEditorStore.setState({
      tabs: [
        { path: 'a.md', name: 'a.md', content: 'old', frontmatter: '', editedContent: 'changed', dirty: true, deleted: false },
        { path: 'b.md', name: 'b.md', content: 'b', frontmatter: '', editedContent: null, dirty: false, deleted: false },
      ],
      activeTab: 'b.md',
    })

    await useEditorStore.getState().closeTab('a.md')

    expect(invoke).toHaveBeenCalledWith('write_file_checked', { path: 'a.md', content: 'changed', baseVersion: null })
    expect(useEditorStore.getState().tabs.map(t => t.path)).toEqual(['b.md'])
    expect(useEditorStore.getState().activeTab).toBe('b.md')
  })

  it('keeps a dirty inactive tab open when its save fails', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('disk full'))
    useEditorStore.setState({
      tabs: [
        { path: 'a.md', name: 'a.md', content: 'old', frontmatter: '', editedContent: 'changed', dirty: true, deleted: false },
        { path: 'b.md', name: 'b.md', content: 'b', frontmatter: '', editedContent: null, dirty: false, deleted: false },
      ],
      activeTab: 'b.md',
    })

    await useEditorStore.getState().closeTab('a.md')

    expect(useEditorStore.getState().tabs.map(t => t.path)).toEqual(['a.md', 'b.md'])
  })

  /** Code mode edits the store directly, so a keystroke while a save is in
   *  flight is already in `editedContent` when the write returns. */
  it('keeps a tab dirty, and saves again, when it was edited while a save was in flight', async () => {
    vi.useFakeTimers()
    try {
      let finishWrite!: (raw: string) => void
      vi.mocked(invoke).mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve as (raw: string) => void }))
      useEditorStore.setState({
        tabs: [{ path: 'a.md', name: 'a.md', content: 'old', frontmatter: '', editedContent: 'first', dirty: true, deleted: false }],
        activeTab: 'a.md',
      })

      const saving = useEditorStore.getState().persistAllDirty()
      await vi.advanceTimersByTimeAsync(0)
      useEditorStore.getState().setEditedContent('a.md', 'first and more')
      useEditorStore.getState().setTabDirty('a.md', true)
      finishWrite(written('v1'))
      await saving

      const tab = useEditorStore.getState().tabs[0]
      expect(tab.content).toBe('first')
      expect(tab.dirty).toBe(true)

      await vi.advanceTimersByTimeAsync(2000)
      expect(invoke).toHaveBeenLastCalledWith('write_file_checked', { path: 'a.md', content: 'first and more', baseVersion: 'v1' })
      expect(useEditorStore.getState().tabs[0].dirty).toBe(false)
    } finally { vi.useRealTimers() }
  })

  /** Saving drops the body's trailing blank lines and puts the file's own ending
   *  back, so an edit changes the edited lines and not git's "No newline at end of
   *  file" marker. */
  describe('what a save keeps of the file layout', () => {
    const saved = async (disk: string, edited: string) => {
      useEditorStore.setState({
        tabs: [{ path: 'a.md', name: 'a.md', content: null, frontmatter: '', editedContent: null, dirty: false, deleted: false }],
        activeTab: 'a.md',
      })
      useEditorStore.getState().setContent('a.md', disk)
      useEditorStore.getState().setEditedContent('a.md', edited)
      useEditorStore.getState().setTabDirty('a.md', true)
      await useEditorStore.getState().persistAllDirty()
      const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'write_file_checked')
      return call ? (call[1] as { content: string }).content : null
    }

    it.each([
      ['a file with a final newline keeps it', '# T\n\nold\n', '# T\n\nnew', '# T\n\nnew\n'],
      ['extra trailing blank lines collapse to one newline', '# T\nold\n', '# T\nnew\n\n\n', '# T\nnew\n'],
      ['a file without a final newline stays without', 'old', 'new', 'new'],
      ['an empty file gets a final newline once it has text', '', '# Hello', '# Hello\n'],
      ['a body edited to nothing is written empty', 'old\n', '', ''],
    ])('%s', async (_name, disk, edited, expected) => {
      expect(await saved(disk, edited)).toBe(expected)
    })

    it('keeps the blank line after the frontmatter', async () => {
      // The editors hand back the body only; the frontmatter owns the blank line.
      expect(await saved('---\ntitle: x\n---\n\n# Heading\nold\n', '# Heading\nnew'))
        .toBe('---\ntitle: x\n---\n\n# Heading\nnew\n')
    })

    it('does not rewrite a file whose text is unchanged', async () => {
      expect(await saved('---\ntitle: x\n---\n\n# Heading\n', '# Heading\n')).toBeNull()
      expect(await saved('no final newline', 'no final newline')).toBeNull()
    })

    /** A file that is only frontmatter can end at the closing fence with no
     *  newline, so the frontmatter has none to give the body a line of its own. */
    it('keeps the closing fence when text is typed into a file that is only frontmatter', async () => {
      const content = await saved('---\ntitle: x\n---', 'Hello')

      expect(content).toBe('---\ntitle: x\n---\nHello')
      expect(splitFrontmatter(content!)).toEqual({ frontmatter: '---\ntitle: x\n---\n', body: 'Hello' })
    })

    it('does the same in a CRLF file', async () => {
      expect(await saved('---\r\ntitle: x\r\n---', 'Hello')).toBe('---\r\ntitle: x\r\n---\r\nHello')
    })

    it('adds no line break when the frontmatter already ends with one', async () => {
      expect(await saved('---\ntitle: x\n---\n', 'Hello')).toBe('---\ntitle: x\n---\nHello\n')
    })

    it('keeps leading blank lines of a file with no frontmatter', async () => {
      expect(await saved('\n\n# T\nold\n', '\n\n# T\nnew')).toBe('\n\n# T\nnew\n')
    })
  })

  it('does not take a leading divider and the next one for frontmatter', () => {
    useEditorStore.setState({
      tabs: [{ path: 'a.md', name: 'a.md', content: null, frontmatter: '', editedContent: null, dirty: false, deleted: false }],
      activeTab: 'a.md',
    })

    useEditorStore.getState().setContent('a.md', '---\n\nIntro section\n\n---\n\nBody')

    const tab = useEditorStore.getState().tabs[0]
    expect(tab.frontmatter).toBe('')
    expect(tab.editedContent).toBe('---\n\nIntro section\n\n---\n\nBody')
  })

  it('reads CRLF frontmatter as frontmatter and saves edits back with CRLF', async () => {
    useEditorStore.setState({
      tabs: [{ path: 'a.md', name: 'a.md', content: null, frontmatter: '', editedContent: null, dirty: false, deleted: false }],
      activeTab: 'a.md',
    })
    const disk = '---\r\ntitle: x\r\n---\r\nline one\r\nline two'

    useEditorStore.getState().setContent('a.md', disk)
    const loaded = useEditorStore.getState().tabs[0]
    expect(loaded.frontmatter).toBe('---\ntitle: x\n---\n')
    expect(loaded.editedContent).toBe('line one\nline two')
    expect(loaded.content).toBe(disk)

    // Unchanged: nothing to write, even though the editors only saw LF.
    useEditorStore.getState().setTabDirty('a.md', true)
    await useEditorStore.getState().persistAllDirty()
    expect(invoke).not.toHaveBeenCalledWith('write_file_checked', expect.anything())

    useEditorStore.getState().setEditedContent('a.md', 'line one\nline 2')
    useEditorStore.getState().setTabDirty('a.md', true)
    await useEditorStore.getState().persistAllDirty()
    expect(invoke).toHaveBeenCalledWith('write_file_checked', {
      path: 'a.md',
      content: '---\r\ntitle: x\r\n---\r\nline one\r\nline 2',
      baseVersion: null,
    })
  })

  /** Closing the active tab should feel like the strip collapsing in place:
   *  the tab to its right takes over, not the most recently opened tab. */
  it('activates the right neighbour of the closed active tab, not the last tab', async () => {
    const tab = (n: string) => ({ path: `${n}.md`, name: `${n}.md`, content: '', frontmatter: '', editedContent: null, dirty: false, deleted: false })
    useEditorStore.setState({ tabs: ['a', 'b', 'c', 'd'].map(tab), activeTab: 'b.md' })

    await useEditorStore.getState().closeTab('b.md')

    expect(useEditorStore.getState().activeTab).toBe('c.md')
  })

  it('falls back to the previous tab when the last active tab is closed', async () => {
    const tab = (n: string) => ({ path: `${n}.md`, name: `${n}.md`, content: '', frontmatter: '', editedContent: null, dirty: false, deleted: false })
    useEditorStore.setState({ tabs: ['a', 'b', 'c'].map(tab), activeTab: 'c.md' })

    await useEditorStore.getState().closeTab('c.md')

    expect(useEditorStore.getState().activeTab).toBe('b.md')
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

  it('autosaves an AI result for an inactive page while another page is active', async () => {
    vi.useFakeTimers()
    try {
      useEditorStore.setState({
        tabs: [
          { path: 'a.md', name: 'a.md', content: 'old', frontmatter: '', editedContent: 'ai result', dirty: false, deleted: false },
          { path: 'b.md', name: 'b.md', content: 'other', frontmatter: '', editedContent: null, dirty: false, deleted: false },
        ],
        activeTab: 'b.md',
      })

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
