import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAiChat } from '../../../frontend/stores/aiChat'
import { useEditorStore } from '../../../frontend/stores/editor'

/** Minimal AIExtension mock for prompt-toggle behavior. */
function makeAi(aiMenuState: unknown) {
  const ai = {
    store: {
      state: { aiMenuState },
      subscribe: () => () => {},
    },
    openAIMenuAtBlock: vi.fn(),
    closeAIMenu: vi.fn(),
    acceptChanges: vi.fn(),
    rejectChanges: vi.fn(),
    abort: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn(),
    invokeAI: vi.fn(),
  }
  return ai
}

function makeEditor(ai: unknown) {
  return {
    getExtension: vi.fn(() => ai),
    getTextCursorPosition: vi.fn(() => ({ block: { id: 'b1' } })),
    getSelection: vi.fn(() => undefined),
  }
}

describe('useAiChat', () => {
  beforeEach(() => {
    useAiChat.setState({ expanded: false, focusRequest: 0 })
    useEditorStore.setState({ blockEditor: null })
  })

  it('requests composer focus and collapses prompt actions', () => {
    useAiChat.setState({ expanded: true })
    useAiChat.getState().focusInput()
    expect(useAiChat.getState()).toMatchObject({ expanded: false, focusRequest: 1 })
  })

  it('does not toggle prompts without an AI-enabled WYSIWYG editor', () => {
    useAiChat.getState().togglePrompts()
    useEditorStore.setState({ blockEditor: makeEditor(null) })
    useAiChat.getState().togglePrompts()
    expect(useAiChat.getState().expanded).toBe(false)
  })

  it('opens prompts at the cursor block and closes an idle menu', () => {
    const ai = makeAi('closed')
    useEditorStore.setState({ blockEditor: makeEditor(ai) })

    useAiChat.getState().togglePrompts()
    expect(ai.openAIMenuAtBlock).toHaveBeenCalledWith('b1')
    expect(useAiChat.getState().expanded).toBe(true)

    ai.store.state.aiMenuState = { blockId: 'b1', status: 'user-input' }
    useAiChat.getState().togglePrompts()
    expect(ai.closeAIMenu).toHaveBeenCalledTimes(1)
    expect(useAiChat.getState().expanded).toBe(false)
  })

  it.each(['thinking', 'ai-writing', 'user-reviewing', 'error'])('does not touch active %s work', (status) => {
    const ai = makeAi({ blockId: 'b1', status })
    useEditorStore.setState({ blockEditor: makeEditor(ai) })

    useAiChat.getState().togglePrompts()

    expect(useAiChat.getState().expanded).toBe(false)
    expect(ai.openAIMenuAtBlock).not.toHaveBeenCalled()
    expect(ai.closeAIMenu).not.toHaveBeenCalled()
    expect(ai.abort).not.toHaveBeenCalled()
    expect(ai.rejectChanges).not.toHaveBeenCalled()
  })
})