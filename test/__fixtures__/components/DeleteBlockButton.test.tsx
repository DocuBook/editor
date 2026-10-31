// @vitest-environment jsdom

/** The IME toolbar's trash button: wires the icon-only control to the
 *  cursor-anchored delete, and stays out of a read-only editor. Command
 *  behaviour itself is covered in utils/deleteBlock.test.ts — a live BlockNote
 *  editor cannot be constructed headless, so the editor and the components are
 *  stubs here. */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const stubs = vi.hoisted(() => ({
  editor: {
    isEditable: true,
    focus: vi.fn(),
    removeBlocks: vi.fn(),
    setTextCursorPosition: vi.fn(),
    getSelection: vi.fn(),
    getTextCursorPosition: vi.fn(),
    getPrevBlock: vi.fn(),
    getNextBlock: vi.fn(),
    getParentBlock: vi.fn(),
  },
}))

vi.mock('@blocknote/react', () => ({
  useBlockNoteEditor: () => stubs.editor,
  useComponentsContext: () => ({
    FormattingToolbar: {
      Button: ({ label, icon, onClick, className }: any) => (
        <button type="button" aria-label={label} className={className} onClick={onClick}>{icon}</button>
      ),
    },
  }),
}))

import { DeleteBlockButton } from '../../../frontend/components/editor/DeleteBlockButton'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  stubs.editor.isEditable = true
  stubs.editor.removeBlocks.mockReset()
  stubs.editor.getSelection.mockReset().mockReturnValue(undefined)
  stubs.editor.getTextCursorPosition.mockReset().mockReturnValue({ block: { id: 'b2' } })
  stubs.editor.getPrevBlock.mockReset().mockReturnValue({ id: 'b1' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('DeleteBlockButton', () => {
  it('renders nothing while the editor is read-only', () => {
    stubs.editor.isEditable = false
    act(() => root.render(<DeleteBlockButton />))
    expect(container.querySelector('button')).toBeNull()
  })

  it('is pinned to the row and deletes the block at the cursor on click', () => {
    act(() => root.render(<DeleteBlockButton />))
    const button = container.querySelector('button')!

    expect(button.getAttribute('aria-label')).toBe('Delete block')
    expect(button.classList.contains('formatting-toolbar-pinned')).toBe(true)

    act(() => button.click())
    expect(stubs.editor.removeBlocks).toHaveBeenCalledWith([{ id: 'b2' }])
  })
})
