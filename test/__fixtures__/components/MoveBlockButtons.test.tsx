// @vitest-environment jsdom

/** The compact toolbar's move buttons: wire the icon-only controls to the
 *  cursor-anchored move commands, and stay out of a read-only editor. Command
 *  behaviour itself is covered in utils/moveBlock.test.ts — a live BlockNote
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
    moveBlocksUp: vi.fn(),
    moveBlocksDown: vi.fn(),
    getSelection: vi.fn(),
    getTextCursorPosition: vi.fn(),
  },
}))

vi.mock('@blocknote/react', () => ({
  useBlockNoteEditor: () => stubs.editor,
  useComponentsContext: () => ({
    FormattingToolbar: {
      Button: ({ label, icon, onClick }: any) => (
        <button type="button" aria-label={label} onClick={onClick}>{icon}</button>
      ),
    },
  }),
}))

import { MoveBlockDownButton, MoveBlockUpButton } from '../../../frontend/components/editor/MoveBlockButtons'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  stubs.editor.isEditable = true
  stubs.editor.focus.mockReset()
  stubs.editor.moveBlocksUp.mockReset()
  stubs.editor.moveBlocksDown.mockReset()
  stubs.editor.getSelection.mockReset().mockReturnValue(undefined)
  stubs.editor.getTextCursorPosition.mockReset().mockReturnValue({ block: { id: 'b1', content: [] } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('MoveBlockButtons', () => {
  it('renders nothing while the editor is read-only', () => {
    stubs.editor.isEditable = false
    act(() => root.render(<MoveBlockUpButton />))
    expect(container.querySelector('button')).toBeNull()
  })

  it('moves up on click', () => {
    act(() => root.render(<MoveBlockUpButton />))
    act(() => container.querySelector('button')!.click())

    expect(stubs.editor.moveBlocksUp).toHaveBeenCalledWith()
    expect(stubs.editor.moveBlocksDown).not.toHaveBeenCalled()
  })

  it('moves down on click', () => {
    act(() => root.render(<MoveBlockDownButton />))
    act(() => container.querySelector('button')!.click())

    expect(stubs.editor.moveBlocksDown).toHaveBeenCalledWith()
    expect(stubs.editor.moveBlocksUp).not.toHaveBeenCalled()
  })
})
