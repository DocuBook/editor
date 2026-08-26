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
    useVaultStore.setState({ tree: [], visibleItems: [], expanded: {}, childrenCache: {}, loading: false })
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
})