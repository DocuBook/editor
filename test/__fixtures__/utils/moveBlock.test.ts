import { describe, expect, it, vi } from 'vitest'
import { moveBlockAtCursor } from '../../../frontend/utils/moveBlock'

/** The editor surface `moveBlockAtCursor` touches, stubbed — a live BlockNote
 *  editor cannot be constructed headless (see utils/editorFactory). */
const makeEditor = ({ selectionBlocks, cursorThrows }: {
  selectionBlocks?: { id: string }[]
  cursorThrows?: boolean
} = {}) => {
  const focus = vi.fn()
  const moveBlocksUp = vi.fn()
  const moveBlocksDown = vi.fn()
  const getTextCursorPosition = vi.fn(() => {
    if (cursorThrows) throw new Error('no text cursor')
    return { block: { id: 'cursor-block', content: [] } }
  })
  const editor = {
    focus,
    moveBlocksUp,
    moveBlocksDown,
    getSelection: () => (selectionBlocks ? { blocks: selectionBlocks } : undefined),
    getTextCursorPosition,
  }
  return { editor, focus, moveBlocksUp, moveBlocksDown, getTextCursorPosition }
}

describe('moveBlockAtCursor', () => {
  it('moves up through the selection, not a block identifier, so the caret follows', () => {
    const { editor, focus, moveBlocksUp, moveBlocksDown } = makeEditor()

    expect(moveBlockAtCursor(editor, 'up')).toBe(true)

    expect(moveBlocksUp).toHaveBeenCalledWith()
    expect(moveBlocksDown).not.toHaveBeenCalled()
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('moves down', () => {
    const { editor, moveBlocksDown } = makeEditor()

    expect(moveBlockAtCursor(editor, 'down')).toBe(true)

    expect(moveBlocksDown).toHaveBeenCalledWith()
  })

  it('needs the text cursor only when nothing is selected', () => {
    const { editor, moveBlocksUp, getTextCursorPosition } = makeEditor({
      selectionBlocks: [{ id: 'b1' }],
      cursorThrows: true,
    })

    expect(moveBlockAtCursor(editor, 'up')).toBe(true)

    expect(moveBlocksUp).toHaveBeenCalledWith()
    expect(getTextCursorPosition).not.toHaveBeenCalled()
  })

  it('moves nothing when there is no selection or cursor', () => {
    const { editor, focus, moveBlocksUp, moveBlocksDown } = makeEditor({ cursorThrows: true })

    expect(moveBlockAtCursor(editor, 'up')).toBe(false)

    expect(moveBlocksUp).not.toHaveBeenCalled()
    expect(moveBlocksDown).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
  })
})
