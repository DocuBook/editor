// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import DeletedEditsDialog from '../../../frontend/components/DeletedEditsDialog'
import { useEditorStore } from '../../../frontend/stores/editor'

vi.mock('../../../frontend/lib/ipc', () => ({
  invoke: vi.fn(),
  listen: vi.fn().mockResolvedValue(() => {}),
  IpcError: class IpcError extends Error {},
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root
const answer = vi.fn()
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')
const button = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === text)!

beforeEach(() => {
  answer.mockReset()
  document.body.innerHTML = '<div id="root"></div>'
  useEditorStore.setState({ deletedPrompt: null, answerDeletedPrompt: answer })
  root = createRoot(document.getElementById('root')!)
  act(() => root.render(<DeletedEditsDialog />))
})
afterEach(() => act(() => root.unmount()))

describe('DeletedEditsDialog', () => {
  it('renders nothing while no question is open', () => {
    expect(dialog()).toBeNull()
  })

  it('names the deleted file and offers Save, Discard and Cancel', () => {
    act(() => useEditorStore.setState({ deletedPrompt: { names: ['notes.md'] } }))
    expect(dialog()!.textContent).toContain('"notes.md" was deleted')
    for (const [label, choice] of [['Save', 'save'], ['Discard', 'discard'], ['Cancel', 'cancel']] as const) {
      act(() => button(label).click())
      expect(answer).toHaveBeenLastCalledWith(choice)
    }
  })

  it('lists every file when several are waiting', () => {
    act(() => useEditorStore.setState({ deletedPrompt: { names: ['a.md', 'b.md'] } }))
    expect(dialog()!.textContent).toContain('2 deleted files have unsaved changes')
    expect(dialog()!.textContent).toContain('a.md, b.md')
  })

  it('cancels on Escape', () => {
    act(() => useEditorStore.setState({ deletedPrompt: { names: ['a.md'] } }))
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(answer).toHaveBeenCalledWith('cancel')
  })
})
