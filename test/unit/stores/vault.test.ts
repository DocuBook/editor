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