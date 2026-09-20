import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useVaultStore } from '../../../frontend/stores/vault'
import { useEditorStore } from '../../../frontend/stores/editor'

vi.mock('../../../frontend/lib/ipc', () => ({
  invoke: vi.fn(),
  openDir: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { invoke } from '../../../frontend/lib/ipc'

/** Regression: after a file CRUD, loadTree must flatten from the FRESH
 *  childrenCache — a same-call flatten reads the pre-update cache and hides
 *  new/renamed files until the next tree op (or hard refresh). */
describe('vault store lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useVaultStore.setState({
      name: '', isOpen: false, vaultPath: '', recent: [],
      tree: [], visibleItems: [], expanded: {}, childrenCache: {}, loading: false, openingPath: null, openingAt: 0,
    })
  })

  it('persists dirty tabs and clears editor state when closing a vault', async () => {
    const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
    mockInvoke.mockResolvedValue(undefined)
    useVaultStore.setState({ name: 'notes', isOpen: true, vaultPath: '/tmp/notes' })
    useEditorStore.setState({
      tabs: [{ path: 'note.md', name: 'note.md', content: '', frontmatter: '---\ntitle: Note\n---\n', editedContent: 'Updated', dirty: true, deleted: false }],
      activeTab: 'note.md', blockEditor: {}, _flushEditor: vi.fn(), canUndo: true, canRedo: true,
    })

    await useVaultStore.getState().closeVault()

    expect(mockInvoke).toHaveBeenNthCalledWith(1, 'write_file', { path: 'note.md', content: '---\ntitle: Note\n---\nUpdated' })
    expect(mockInvoke).toHaveBeenNthCalledWith(2, 'close_vault')
    expect(useEditorStore.getState()).toMatchObject({ tabs: [], activeTab: null, blockEditor: null, _flushEditor: null, canUndo: false, canRedo: false })
    expect(useVaultStore.getState()).toMatchObject({ name: '', isOpen: false, vaultPath: '', tree: [], visibleItems: [], expanded: {}, childrenCache: {} })
  })

  it('keeps the vault and tabs open when saving before close fails', async () => {
    const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
    mockInvoke.mockRejectedValueOnce(new Error('disk full'))
    useVaultStore.setState({ name: 'notes', isOpen: true, vaultPath: '/tmp/notes' })
    useEditorStore.setState({
      tabs: [{ path: 'note.md', name: 'note.md', content: '', frontmatter: '', editedContent: 'Updated', dirty: true, deleted: false }],
      activeTab: 'note.md',
    })

    await useVaultStore.getState().closeVault()

    expect(mockInvoke).not.toHaveBeenCalledWith('close_vault')
    expect(useEditorStore.getState().tabs).toHaveLength(1)
    expect(useVaultStore.getState()).toMatchObject({ name: 'notes', isOpen: true, vaultPath: '/tmp/notes' })
  })

  it('shows a newly created file in an expanded folder after loadTree', async () => {
    const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
    const folder = { path: 'notes', name: 'notes', type: '1' }
    // First load: root tree has the folder; folder is expanded with old children.
    mockInvoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'list_tree' && args?.subpath === '') return JSON.stringify([folder])
      if (cmd === 'list_tree' && args?.subpath === 'notes') return JSON.stringify([{ path: 'notes/old.md', name: 'old.md', type: '0' }])
      return '[]'
    })
    useVaultStore.setState({ expanded: { notes: true } })
    await useVaultStore.getState().loadTree()
    expect(useVaultStore.getState().visibleItems.some(i => i.path === 'notes/old.md')).toBe(true)

    // CRUD: a new file lands in the folder. list_tree now returns both.
    mockInvoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'list_tree' && args?.subpath === '') return JSON.stringify([folder])
      if (cmd === 'list_tree' && args?.subpath === 'notes') return JSON.stringify([
        { path: 'notes/old.md', name: 'old.md', type: '0' },
        { path: 'notes/new.md', name: 'new.md', type: '0' },
      ])
      return '[]'
    })
    await useVaultStore.getState().loadTree()
    const vis = useVaultStore.getState().visibleItems.map(i => i.path)
    expect(vis).toContain('notes/new.md')
    expect(vis).toContain('notes/old.md')
  })

  it('keeps concurrent folder expansions independent', async () => {
    const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
    let resolveA!: (value: string) => void
    mockInvoke.mockImplementation((cmd: string, args?: any) => {
      if (cmd !== 'list_tree') return Promise.resolve('[]')
      if (args?.subpath === 'a') return new Promise(resolve => { resolveA = resolve })
      if (args?.subpath === 'b') return Promise.resolve(JSON.stringify([{ path: 'b/note.md', name: 'note.md', type: '0' }]))
      return Promise.resolve('[]')
    })
    useVaultStore.setState({ name: 'notes', isOpen: true, vaultPath: '/tmp/notes', tree: [
      { path: 'a', name: 'a', type: '1' }, { path: 'b', name: 'b', type: '1' },
    ] })

    const aRequest = useVaultStore.getState().toggleFolder({ path: 'a', name: 'a', type: '1' })
    const bRequest = useVaultStore.getState().toggleFolder({ path: 'b', name: 'b', type: '1' })
    await bRequest
    resolveA(JSON.stringify([{ path: 'a/note.md', name: 'note.md', type: '0' }]))
    await aRequest

    const paths = useVaultStore.getState().visibleItems.map(item => item.path)
    expect(paths).toEqual(['a', 'a/note.md', 'b', 'b/note.md'])
  })

  it('keeps nested expansion state across parent collapse and re-expand', async () => {
    const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
    mockInvoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd !== 'list_tree') return '[]'
      if (args?.subpath === 'parent') return JSON.stringify([{ path: 'parent/child', name: 'child', type: '1' }])
      if (args?.subpath === 'parent/child') return JSON.stringify([{ path: 'parent/child/note.md', name: 'note.md', type: '0' }])
      return '[]'
    })
    const parent = { path: 'parent', name: 'parent', type: '1' }
    useVaultStore.setState({ name: 'notes', isOpen: true, vaultPath: '/tmp/notes', tree: [parent] })

    await useVaultStore.getState().toggleFolder(parent)
    await useVaultStore.getState().toggleFolder({ path: 'parent/child', name: 'child', type: '1' })
    expect(useVaultStore.getState().visibleItems.map(item => item.path)).toEqual([
      'parent', 'parent/child', 'parent/child/note.md',
    ])

    await useVaultStore.getState().toggleFolder(parent)
    expect(useVaultStore.getState().visibleItems.map(item => item.path)).toEqual(['parent'])

    await useVaultStore.getState().toggleFolder(parent)
    expect(useVaultStore.getState().visibleItems.map(item => item.path)).toEqual([
      'parent', 'parent/child', 'parent/child/note.md',
    ])
  })

  it('blocks direct vault switch when dirty tab save fails', async () => {
    const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
    mockInvoke.mockRejectedValueOnce(new Error('disk full'))
    useVaultStore.setState({ name: 'old', isOpen: true, vaultPath: '/tmp/old' })
    useEditorStore.setState({
      tabs: [{ path: 'note.md', name: 'note.md', content: '', frontmatter: '', editedContent: 'Updated', dirty: true, deleted: false }],
      activeTab: 'note.md',
    })

    await useVaultStore.getState().openRecent('/tmp/new')

    expect(mockInvoke).toHaveBeenCalledWith('write_file', { path: 'note.md', content: 'Updated' })
    expect(mockInvoke).not.toHaveBeenCalledWith('open_vault', { path: '/tmp/new' })
    expect(useVaultStore.getState()).toMatchObject({ name: 'old', isOpen: true, vaultPath: '/tmp/old' })
    expect(useEditorStore.getState().tabs).toHaveLength(1)
  })

  it('resumes the last vault without closing and restores its tabs', async () => {
    const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'open_vault') return JSON.stringify({ name: 'notes' })
      if (cmd === 'list_tree') return '[]'
      if (cmd === 'read_file') return '# Restored'
      return undefined
    })
    useVaultStore.setState({ vaultPath: '/tmp/notes', recent: [{ path: '/tmp/notes', name: 'notes', parent: '/tmp' }] })
    useEditorStore.setState({
      tabs: [{ path: 'note.md', name: 'note.md', content: null, frontmatter: '', editedContent: null, dirty: false, deleted: false }],
      activeTab: 'note.md',
    })

    await useVaultStore.getState().resumeVault()

    expect(useEditorStore.getState().tabs).toHaveLength(1)
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ path: 'note.md', content: '# Restored' })
    expect(useEditorStore.getState().activeTab).toBe('note.md')
    expect(mockInvoke).toHaveBeenCalledWith('read_file', { path: 'note.md' })
  })

  it('closes existing tabs when explicitly opening another vault', async () => {
    const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'open_vault') return JSON.stringify({ name: 'new' })
      if (cmd === 'list_tree') return '[]'
      return undefined
    })
    useEditorStore.setState({
      tabs: [{ path: 'old.md', name: 'old.md', content: '', frontmatter: '', editedContent: null, dirty: false, deleted: false }],
      activeTab: 'old.md',
    })

    await useVaultStore.getState().openRecent('/tmp/new')

    expect(useEditorStore.getState().tabs).toHaveLength(0)
    expect(useEditorStore.getState().activeTab).toBeNull()
    expect(mockInvoke).not.toHaveBeenCalledWith('read_file', expect.anything())
  })

  it('ignores a stale tree response after vault identity changes', async () => {
    const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
    let resolveTree!: (value: string) => void
    mockInvoke.mockImplementationOnce(() => new Promise(resolve => { resolveTree = resolve }))
    useVaultStore.setState({ name: 'old', isOpen: true, vaultPath: '/tmp/old', tree: [], visibleItems: [] })

    const request = useVaultStore.getState().loadTree()
    useVaultStore.setState({ name: 'new', isOpen: true, vaultPath: '/tmp/new', tree: [], visibleItems: [] })
    resolveTree(JSON.stringify([{ path: 'old.md', name: 'old.md', type: '0' }]))
    await request

    expect(useVaultStore.getState().tree).toEqual([])
    expect(useVaultStore.getState().visibleItems).toEqual([])
  })

  it('renders persisted expanded folders with children on fresh load (rehydrate path)', async () => {
    const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
    mockInvoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'list_tree' && args?.subpath === '') return JSON.stringify([{ path: 'docs', name: 'docs', type: '1' }])
      if (cmd === 'list_tree' && args?.subpath === 'docs') return JSON.stringify([{ path: 'docs/a.md', name: 'a.md', type: '0' }])
      return '[]'
    })
    // Persisted state: docs was expanded in a previous session; cache starts empty.
    useVaultStore.setState({ expanded: { docs: true }, childrenCache: {} })
    await useVaultStore.getState().loadTree()
    const vis = useVaultStore.getState().visibleItems.map(i => i.path)
    expect(vis).toContain('docs')
    expect(vis).toContain('docs/a.md')
  })

  /** Regression: a recent-vault open left `isOpen` false until the backend
   *  answered, so Editor kept rendering the welcome screen and a slow (large)
   *  vault open looked like a dead click. `openingPath` must be set for the whole
   *  in-flight window, then cleared on both success and failure. */
  it('flags an in-flight open while the backend is still resolving it', async () => {
    const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
    let resolveOpen!: (value: string) => void
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'open_vault') return new Promise(resolve => { resolveOpen = resolve })
      return Promise.resolve('[]')
    })
    const started = useVaultStore.getState().openRecent('/tmp/big')
    // `openRecent` awaits prepareTransition first, so let those microtasks drain
    // before observing the in-flight window.
    await vi.waitFor(() => expect(useVaultStore.getState().openingPath).toBe('/tmp/big'))

    // Backend has not answered yet: the overlay must already be showing.
    expect(useVaultStore.getState().openingAt).toBeGreaterThan(0)
    expect(useVaultStore.getState().isOpen).toBe(false)

    resolveOpen(JSON.stringify({ name: 'big' }))
    await started

    expect(useVaultStore.getState()).toMatchObject({ openingPath: null, isOpen: true, name: 'big' })
  })

  it('clears the in-flight open flag when the vault cannot be found', async () => {
    const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === 'open_vault' ? Promise.reject(new Error('not found')) : Promise.resolve(undefined))
    useVaultStore.setState({
      name: '', isOpen: false, vaultPath: '', recent: [{ path: '/tmp/gone', name: 'gone', parent: '/tmp' }],
    })

    await useVaultStore.getState().openRecent('/tmp/gone')

    // Flag cleared so the welcome screen comes back instead of spinning forever,
    // and the dead vault is dropped from the recent list.
    expect(useVaultStore.getState().openingPath).toBeNull()
    expect(useVaultStore.getState().recent).toEqual([])
  })

  /** The stale-transition return in `openRecent` used to leave `openingPath`
   *  set. `beginTransition` refuses a second transition while one is in flight,
   *  so reaching it needs the flag to be set outside the normal entry points —
   *  which is exactly what a persisted/hydrated state or a future caller can do.
   *  Assert the invariant directly: whatever supersedes the open, the flag clears. */
  it('clears the in-flight flag when the open is superseded out-of-band', async () => {
    const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
    let resolveOpen!: (value: string) => void
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'open_vault') return new Promise(resolve => { resolveOpen = resolve })
      return Promise.resolve('[]')
    })

    const first = useVaultStore.getState().openRecent('/tmp/one')
    await vi.waitFor(() => expect(useVaultStore.getState().openingPath).toBe('/tmp/one'))

    // Simulate a superseding transition (another tab, an unmount/remount, or a
    // future caller bumping the generation) without going through beginTransition,
    // which would be refused while this open is still in flight.
    useVaultStore.getState().closeVault()
    resolveOpen(JSON.stringify({ name: 'one' }))
    await first

    // Whichever path won, the overlay must not outlive the attempt.
    expect(useVaultStore.getState().openingPath).toBeNull()
  })

  /** Clone is the slowest open path, so it gets the overlay rather than only the
   *  in-button label. The flag must be cleared on both exits. */
  it('flags an in-flight clone and clears it once the repo is open', async () => {
    const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
    let resolveClone!: (value: string) => void
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'git_clone') return new Promise(resolve => { resolveClone = resolve })
      return Promise.resolve('[]')
    })

    const clone = useVaultStore.getState().cloneVault('https://github.com/user/notes.git', '/tmp')
    await vi.waitFor(() => expect(useVaultStore.getState().openingPath).toBe('https://github.com/user/notes.git'))
    expect(useVaultStore.getState().isOpen).toBe(false)

    resolveClone(JSON.stringify({ name: 'notes', path: '/tmp/notes' }))
    await clone

    expect(useVaultStore.getState()).toMatchObject({ openingPath: null, isOpen: true, name: 'notes' })
  })

  it('clears the in-flight flag when a clone fails', async () => {
    const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === 'git_clone' ? Promise.reject(new Error('auth failed')) : Promise.resolve(undefined))

    // The rejection is rethrown for the caller's inline error message, but the
    // overlay must not survive it.
    await expect(useVaultStore.getState().cloneVault('https://github.com/user/private.git', '/tmp'))
      .rejects.toThrow('auth failed')

    expect(useVaultStore.getState().openingPath).toBeNull()
  })
})
