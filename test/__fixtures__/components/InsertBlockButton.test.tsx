// @vitest-environment jsdom

/** The compact toolbar's insert button: wires the icon-only control to the
 *  cursor-anchored insert, and stays out of a read-only editor. The insert flow
 *  itself is covered in utils/insertBlock.test.ts — a live BlockNote editor
 *  cannot be constructed headless, so the editor and the components are stubs
 *  here. */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const stubs = vi.hoisted(() => ({
  editor: {
    isEditable: true,
    getTextCursorPosition: vi.fn(),
    insertBlocks: vi.fn(),
    setTextCursorPosition: vi.fn(),
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

import { InsertBlockButton } from '../../../frontend/components/editor/InsertBlockButton'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  stubs.editor.isEditable = true
  stubs.editor.getTextCursorPosition.mockReset().mockReturnValue({ block: { id: 'b1', content: [] } })
  stubs.editor.insertBlocks.mockReset().mockReturnValue([{ id: 'b2' }])
  stubs.editor.setTextCursorPosition.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('InsertBlockButton', () => {
  it('renders nothing while the editor is read-only', () => {
    stubs.editor.isEditable = false
    act(() => root.render(<InsertBlockButton />))
    expect(container.querySelector('button')).toBeNull()
  })

  it('inserts a paragraph after the cursor block and moves the caret onto it', () => {
    act(() => root.render(<InsertBlockButton />))
    act(() => container.querySelector('button')!.click())

    expect(stubs.editor.insertBlocks).toHaveBeenCalledWith([{ type: 'paragraph' }], { id: 'b1', content: [] }, 'after')
    expect(stubs.editor.setTextCursorPosition).toHaveBeenCalledWith({ id: 'b2' }, 'start')
  })
})
