import { describe, it, expect, vi, beforeEach } from 'vitest'
import { toast } from 'sonner'
import { useEditorStore } from '../../../frontend/stores/editor'
import { invoke } from '../../../frontend/lib/ipc'

vi.mock('../../../frontend/lib/ipc', () => ({
  invoke: vi.fn().mockResolvedValue(''),
  listen: vi.fn().mockResolvedValue(() => {}),
  IpcError: class IpcError extends Error {},
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

describe('editor store diff tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useEditorStore.setState({ tabs: [], activeTab: null })
  })

  it('opens the diff of a file deleted from the worktree without an error toast', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'read_file') throw new Error('No such file or directory (os error 2)')
      return null
    })

    await useEditorStore.getState().openDiff('notes/gone.md', 'gone.md', false, true)

    const tab = useEditorStore.getState().tabs.find(t => t.path === 'notes/gone.md')!
    expect(toast.error).not.toHaveBeenCalled()
    expect(tab.view).toBe('diff')
    expect(tab.deleted).toBe(true)
    expect(tab.content).toBe('')
  })

  it('does not mark a modified file deleted just because its quoted path cannot be read', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'read_file') throw new Error('No such file or directory (os error 2)')
      return null
    })

    await useEditorStore.getState().openDiff('"notes/line\\nbreak.md"', 'line\nbreak.md', false)

    const tab = useEditorStore.getState().tabs[0]
    expect(tab.view).toBe('diff')
    expect(tab.deleted).toBe(false)
  })

  it('still reports a missing file opened as a normal tab', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'read_file') throw new Error('No such file or directory (os error 2)')
      return null
    })

    await useEditorStore.getState().openFile('notes/gone.md', 'gone.md')

    expect(toast.error).toHaveBeenCalledWith('File not found')
    expect(useEditorStore.getState().tabs[0].deleted).toBe(false)
  })
})
