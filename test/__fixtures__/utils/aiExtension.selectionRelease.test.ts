import { describe, expect, it, vi } from 'vitest'

import { AIExtension } from '../../../frontend/utils/aiExtension'

vi.mock('../../../frontend/utils/softKeyboard', () => ({
  softKeyboardOnFocus: vi.fn(() => false),
}))

/** Minimal stand-in for `releaseAISelection`'s path: a live block selection and
 *  a settable text cursor. */
function makeEditor(selection: any) {
  const showSelection = vi.fn()
  const setTextCursorPosition = vi.fn()
  return {
    editor: {
      document: [],
      isEditable: true,
      getSelection: vi.fn(() => selection),
      setTextCursorPosition,
      getExtension: vi.fn((name: string) => (name === 'showSelection' ? { showSelection } : undefined)),
      focus: vi.fn(),
      replaceBlocks: vi.fn(),
    },
    showSelection,
    setTextCursorPosition,
  }
}

function makeAi(editor: any) {
  return (AIExtension as any)({
    transport: { sendMessages: vi.fn() },
    documentStateBuilder: async () => ({ blocks: [] }),
  })({ editor })
}

/** Regression: accepting or reverting left the request's text selection live, so
 *  BlockNote's formatting toolbar (the text-selection popover) re-appeared the
 *  moment the AI menu closed and the caret returned to the editor. */
describe('AI extension selection release', () => {
  it('collapses the request selection when the result is accepted', () => {
    const { editor, setTextCursorPosition } = makeEditor({ blocks: [{ id: 'b1' }, { id: 'b2' }] })
    const ai: any = makeAi(editor)

    ai.openAIMenuAtBlock('b1')
    ai.acceptChanges()

    expect(setTextCursorPosition).toHaveBeenCalledWith('b2', 'end')
  })

  it('collapses it when the result is reverted', () => {
    const { editor, setTextCursorPosition } = makeEditor({ blocks: [{ id: 'only' }] })
    const ai: any = makeAi(editor)

    ai.openAIMenuAtBlock('only')
    ai.rejectChanges()

    expect(setTextCursorPosition).toHaveBeenCalledWith('only', 'end')
  })

  it('keeps the reader selection when the menu is only dismissed', () => {
    const { editor, setTextCursorPosition } = makeEditor({ blocks: [{ id: 'b1' }] })
    const ai: any = makeAi(editor)

    ai.openAIMenuAtBlock('b1')
    ai.closeAIMenu()

    expect(setTextCursorPosition).not.toHaveBeenCalled()
  })

  it('is a no-op for a cursor-mode close with no selection', () => {
    const { editor, setTextCursorPosition } = makeEditor(undefined)
    const ai: any = makeAi(editor)

    ai.openAIMenuAtBlock('b1')
    ai.acceptChanges()

    expect(setTextCursorPosition).not.toHaveBeenCalled()
  })
})
