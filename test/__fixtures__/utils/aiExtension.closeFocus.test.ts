import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AIExtension } from '../../../frontend/utils/aiExtension'
import { softKeyboardOnFocus } from '../../../frontend/utils/softKeyboard'

vi.mock('../../../frontend/utils/softKeyboard', () => ({
  softKeyboardOnFocus: vi.fn(() => false),
}))

/** Minimal BlockNote editor stand-in: `close()` only releases the selection
 *  extension, unlocks the editor and restores the caret. */
function makeEditor() {
  const showSelection = vi.fn()
  return {
    editor: {
      document: [],
      isEditable: true,
      getExtension: vi.fn((name: string) => (name === 'showSelection' ? { showSelection } : undefined)),
      focus: vi.fn(),
      getSelection: vi.fn(() => undefined),
    },
    showSelection,
  }
}

function makeAi(editor: any) {
  return (AIExtension as any)({
    transport: { sendMessages: vi.fn() },
    documentStateBuilder: async () => ({ blocks: [] }),
  })({ editor })
}

describe('AI extension close focus', () => {
  beforeEach(() => {
    vi.mocked(softKeyboardOnFocus).mockReset()
  })

  /* The toggle path in the user report: collapsing the prompt panel closes the
     menu while the AI composer is still on screen. */
  it('returns the caret to the editor where focusing raises no soft keyboard', () => {
    vi.mocked(softKeyboardOnFocus).mockReturnValue(false)
    const { editor, showSelection } = makeEditor()
    const ai: any = makeAi(editor)

    ai.openAIMenuAtBlock('b1')
    ai.closeAIMenu()

    expect(editor.focus).toHaveBeenCalledTimes(1)
    expect(editor.isEditable).toBe(true)
    expect(showSelection).toHaveBeenLastCalledWith(false, 'aiMenu')
    expect(ai.store.state.aiMenuState).toBe('closed')
  })

  it('leaves the caret alone on a system whose focus raises the soft keyboard', () => {
    vi.mocked(softKeyboardOnFocus).mockReturnValue(true)
    const { editor, showSelection } = makeEditor()
    const ai: any = makeAi(editor)

    ai.openAIMenuAtBlock('b1')
    ai.acceptChanges()

    /* Regression: the caret restore raised the IME over the still-open AI
       composer, which is BlockNote's gate for the mobile formatting toolbar —
       the strip appeared and the composer was lifted above it mid-dismissal. */
    expect(editor.focus).not.toHaveBeenCalled()
    expect(editor.isEditable).toBe(true)
    expect(showSelection).toHaveBeenLastCalledWith(false, 'aiMenu')
    expect(ai.store.state.aiMenuState).toBe('closed')
  })
})
