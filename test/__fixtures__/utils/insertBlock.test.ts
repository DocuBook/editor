import { describe, expect, it, vi } from 'vitest'
import { insertBlockAtCursor } from '../../../frontend/utils/insertBlock'

/** The editor surface `insertBlockAtCursor` touches, stubbed — a live BlockNote
 *  editor cannot be constructed headless (see utils/editorFactory). */
const makeEditor = ({ insertResult, cursorThrows }: {
  insertResult?: { id: string }[]
  cursorThrows?: boolean
} = {}) => {
  const block = { id: 'cursor-block', content: [] }
  const insertBlocks = vi.fn(() => insertResult ?? [{ id: 'inserted-block' }])
  const setTextCursorPosition = vi.fn()
  const editor = {
    getTextCursorPosition: () => {
      if (cursorThrows) throw new Error('no text cursor')
      return { block }
    },
    insertBlocks,
    setTextCursorPosition,
  }
  return { block, editor, insertBlocks, setTextCursorPosition }
}

describe('insertBlockAtCursor', () => {
  it('inserts a paragraph below the cursor block and puts the caret on it', () => {
    const { block, editor, insertBlocks, setTextCursorPosition } = makeEditor()

    expect(insertBlockAtCursor(editor)).toBe(true)

    expect(insertBlocks).toHaveBeenCalledWith([{ type: 'paragraph' }], block, 'after')
    expect(setTextCursorPosition).toHaveBeenCalledWith({ id: 'inserted-block' }, 'start')
  })

  it('inserts below an empty block too — the toolbar never opens the slash menu', () => {
    /* `/` is the only route to the type menu; a `+` that opened it made adding a
       block ambiguous between a click and a keystroke. An empty current block
       (the cursor is already in one) does not change that. */
    const { block, editor, insertBlocks } = makeEditor()

    expect(insertBlockAtCursor(editor)).toBe(true)

    expect(insertBlocks).toHaveBeenCalledWith([{ type: 'paragraph' }], block, 'after')
  })

  it('inserts nothing when there is no text cursor to anchor on', () => {
    const { editor, insertBlocks } = makeEditor({ cursorThrows: true })

    expect(insertBlockAtCursor(editor)).toBe(false)

    expect(insertBlocks).not.toHaveBeenCalled()
  })

  it('inserts nothing when the insertion produced no block', () => {
    const { editor, setTextCursorPosition } = makeEditor({ insertResult: [] })

    expect(insertBlockAtCursor(editor)).toBe(false)

    expect(setTextCursorPosition).not.toHaveBeenCalled()
  })
})
