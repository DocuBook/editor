import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useVaultStore } from './vault'

vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(),
  openDir: vi.fn(),
}))

import { invoke } from '../lib/ipc'

/** Regression: after a file CRUD, loadTree must flatten from the FRESH
 *  childrenCache — a same-call flatten reads the pre-update cache and hides
 *  new/renamed files until the next tree op (or hard refresh). */
describe('vault store tree freshness after CRUD', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useVaultStore.setState({ tree: [], visibleItems: [], expanded: {}, childrenCache: {}, loading: false })
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