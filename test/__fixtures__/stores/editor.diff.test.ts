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

  it('reads a quoted name through its real path and diffs it through the quoted form', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'read_file') {
        if ((args as { path: string }).path === 'notes/line\nbreak.md') return 'body'
        throw new Error('No such file or directory (os error 2)')
      }
      return null
    })

    await useEditorStore.getState().openDiff('notes/line\nbreak.md', 'line\nbreak.md', false, false, '"notes/line\\nbreak.md"')

    const tab = useEditorStore.getState().tabs[0]
    expect(toast.error).not.toHaveBeenCalled()
    expect(tab.path).toBe('notes/line\nbreak.md')
    expect(tab.content).toBe('body')
    expect(tab.diffPath).toBe('"notes/line\\nbreak.md"')
    expect(tab.deleted).toBe(false)
  })

  it('opens a diff for a name no string path can address without an error toast', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'read_file') throw new Error('No such file or directory (os error 2)')
      return null
    })

    await useEditorStore.getState().openDiff('"caf\\351.md"', 'caf\uFFFD.md', false, false, '"caf\\351.md"')

    const tab = useEditorStore.getState().tabs[0]
    expect(toast.error).not.toHaveBeenCalled()
    expect(tab.view).toBe('diff')
    expect(tab.deleted).toBe(false)
  })

  it('drops the git path when the tab is reopened as an editor', async () => {
    vi.mocked(invoke).mockResolvedValue('body')
    await useEditorStore.getState().openDiff('a.md', 'a.md', false, false, 'a.md')
    await useEditorStore.getState().openFile('a.md', 'a.md')

    const tab = useEditorStore.getState().tabs[0]
    expect(tab.view).toBeUndefined()
    expect(tab.diffPath).toBeUndefined()
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
