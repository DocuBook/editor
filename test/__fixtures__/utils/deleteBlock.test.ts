import { describe, expect, it, vi } from 'vitest'
import { deleteBlockAtCursor } from '../../../frontend/utils/deleteBlock'

type Block = { id: string }

/** The editor surface `deleteBlockAtCursor` touches, stubbed — a live BlockNote
 *  editor cannot be constructed headless (see utils/editorFactory). */
const makeEditor = ({ selectionBlocks, cursorThrows, prev, next, parent, caretThrows }: {
  selectionBlocks?: Block[]
  cursorThrows?: boolean
  prev?: Block
  next?: Block
  parent?: Block
  caretThrows?: boolean
} = {}) => {
  const editor = {
    focus: vi.fn(),
    removeBlocks: vi.fn(),
    replaceBlocks: vi.fn(() => ({ insertedBlocks: [{ id: 'blank' }], removedBlocks: [] })),
    setTextCursorPosition: vi.fn(() => { if (caretThrows) throw new Error('no inline content') }),
    getSelection: () => (selectionBlocks ? { blocks: selectionBlocks } : undefined),
    getTextCursorPosition: vi.fn(() => {
      if (cursorThrows) throw new Error('no text cursor')
      return { block: { id: 'cursor-block' } }
    }),
    getPrevBlock: vi.fn(() => prev),
    getNextBlock: vi.fn(() => next),
    getParentBlock: vi.fn(() => parent),
  }
  return editor
}

describe('deleteBlockAtCursor', () => {
  it('deletes the block at the cursor and puts the caret at the end of the previous one', () => {
    const editor = makeEditor({ prev: { id: 'p' }, next: { id: 'n' } })

    expect(deleteBlockAtCursor(editor)).toBe(true)

    expect(editor.removeBlocks).toHaveBeenCalledWith([{ id: 'cursor-block' }])
    expect(editor.setTextCursorPosition).toHaveBeenCalledWith({ id: 'p' }, 'end')
    expect(editor.focus).toHaveBeenCalledTimes(1)
  })

  it('deletes every selected block, looking for neighbours around the whole range', () => {
    const selection = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const editor = makeEditor({ selectionBlocks: selection, cursorThrows: true, next: { id: 'n' } })

    expect(deleteBlockAtCursor(editor)).toBe(true)

    expect(editor.removeBlocks).toHaveBeenCalledWith(selection)
    expect(editor.getPrevBlock).toHaveBeenCalledWith({ id: 'a' })
    expect(editor.getNextBlock).toHaveBeenCalledWith({ id: 'c' })
    expect(editor.getTextCursorPosition).not.toHaveBeenCalled()
  })

  it('falls back to the start of the next block, then the end of the parent', () => {
    const first = makeEditor({ next: { id: 'n' }, parent: { id: 'up' } })
    deleteBlockAtCursor(first)
    expect(first.setTextCursorPosition).toHaveBeenCalledWith({ id: 'n' }, 'start')

    const nested = makeEditor({ parent: { id: 'up' } })
    deleteBlockAtCursor(nested)
    expect(nested.removeBlocks).toHaveBeenCalledWith([{ id: 'cursor-block' }])
    expect(nested.setTextCursorPosition).toHaveBeenCalledWith({ id: 'up' }, 'end')
  })

  it('leaves one empty paragraph instead of an empty document', () => {
    const editor = makeEditor()

    expect(deleteBlockAtCursor(editor)).toBe(true)

    expect(editor.removeBlocks).not.toHaveBeenCalled()
    expect(editor.replaceBlocks).toHaveBeenCalledWith([{ id: 'cursor-block' }], [{ type: 'paragraph' }])
    expect(editor.setTextCursorPosition).toHaveBeenCalledWith({ id: 'blank' }, 'start')
  })

  it('keeps the deletion when the neighbour takes no caret', () => {
    const editor = makeEditor({ prev: { id: 'image' }, caretThrows: true })

    expect(deleteBlockAtCursor(editor)).toBe(true)

    expect(editor.removeBlocks).toHaveBeenCalledTimes(1)
  })

  it('deletes nothing when there is no selection or cursor', () => {
    const editor = makeEditor({ cursorThrows: true })

    expect(deleteBlockAtCursor(editor)).toBe(false)

    expect(editor.removeBlocks).not.toHaveBeenCalled()
    expect(editor.replaceBlocks).not.toHaveBeenCalled()
    expect(editor.focus).not.toHaveBeenCalled()
  })
})
