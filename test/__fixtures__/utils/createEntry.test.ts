import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  openFile: vi.fn(),
  loadTree: vi.fn(),
}))

vi.mock('../../../frontend/lib/ipc', () => ({ invoke: mocks.invoke }))
vi.mock('../../../frontend/stores/editor', () => ({ useEditorStore: { getState: () => ({ openFile: mocks.openFile }) } }))
vi.mock('../../../frontend/stores/vault', () => ({ useVaultStore: { getState: () => ({ loadTree: mocks.loadTree }) } }))

import { createEntry } from '../../../frontend/utils/createEntry'

/** Every create surface (compact New note, sidebar form, menu, popover, shortcuts)
 *  goes through this helper, so its folder join and open/reload steps are the
 *  behavior all of them share. */
describe('createEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.invoke.mockImplementation(async (_cmd: string, args: { path: string }) => args.path.endsWith('.md') || args.path.includes('.') ? args.path : `${args.path}.md`)
  })

  it('joins the name onto the current folder and opens the created note', async () => {
    const created = await createEntry('file', 'launch', 'notes')
    expect(mocks.invoke).toHaveBeenCalledWith('create_entry', { kind: 'file', path: 'notes/launch' })
    expect(created).toBe('notes/launch.md')
    expect(mocks.openFile).toHaveBeenCalledWith('notes/launch.md', 'launch.md')
    expect(mocks.loadTree).toHaveBeenCalledTimes(1)
  })

  it('does not double the folder when the name already starts with it', async () => {
    await createEntry('file', 'notes/launch', 'notes')
    expect(mocks.invoke).toHaveBeenCalledWith('create_entry', { kind: 'file', path: 'notes/launch' })
  })

  it('creates a folder without opening anything, then reloads the tree', async () => {
    mocks.invoke.mockResolvedValue('drafts')
    await createEntry('folder', 'drafts')
    expect(mocks.invoke).toHaveBeenCalledWith('create_entry', { kind: 'folder', path: 'drafts' })
    expect(mocks.openFile).not.toHaveBeenCalled()
    expect(mocks.loadTree).toHaveBeenCalledTimes(1)
  })

  it('does not reload the tree when the vault refuses the name', async () => {
    mocks.invoke.mockRejectedValue(new Error('"idea.md" already exists in this folder'))
    await expect(createEntry('file', 'idea')).rejects.toThrow('already exists')
    expect(mocks.openFile).not.toHaveBeenCalled()
    expect(mocks.loadTree).not.toHaveBeenCalled()
  })
})
