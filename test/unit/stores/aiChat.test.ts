import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAiChat } from '../../../frontend/stores/aiChat'
import { useEditorStore } from '../../../frontend/stores/editor'

/** Minimal AIExtension mock — mirrors the extension's vanilla store (state +
 *  subscribe) and the methods AiFloatingChat/aiChat toggle actually call. */
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

describe('useAiChat.toggle (⌃⌥L / FAB)', () => {
  beforeEach(() => {
    useAiChat.setState({ expanded: false })
    useEditorStore.setState({ blockEditor: null })
  })

  it('is a no-op without a mounted WYSIWYG editor', () => {
    useAiChat.getState().toggle()
    expect(useAiChat.getState().expanded).toBe(false)
  })

  it('is a no-op when the editor has no AI extension', () => {
    useEditorStore.setState({ blockEditor: makeEditor(null) })
    useAiChat.getState().toggle()
    expect(useAiChat.getState().expanded).toBe(false)
  })

  it('opens the AI menu at the cursor block and expands when closed', () => {
    const ai = makeAi('closed')
    useEditorStore.setState({ blockEditor: makeEditor(ai) })
    useAiChat.getState().toggle()
    expect(ai.openAIMenuAtBlock).toHaveBeenCalledWith('b1')
    expect(useAiChat.getState().expanded).toBe(true)
  })

  it('closes a user-input menu and collapses', () => {
    const ai = makeAi({ blockId: 'b1', status: 'user-input' })
    useEditorStore.setState({ blockEditor: makeEditor(ai) })
    useAiChat.getState().toggle()
    expect(ai.closeAIMenu).toHaveBeenCalledTimes(1)
    expect(ai.abort).not.toHaveBeenCalled()
    expect(ai.rejectChanges).not.toHaveBeenCalled()
    expect(useAiChat.getState().expanded).toBe(false)
  })

  it('aborts a streaming request (thinking / ai-writing) and collapses', () => {
    const ai = makeAi({ blockId: 'b1', status: 'ai-writing' })
    useEditorStore.setState({ blockEditor: makeEditor(ai) })
    useAiChat.getState().toggle()
    expect(ai.abort).toHaveBeenCalledWith(expect.any(String))
    expect(ai.closeAIMenu).not.toHaveBeenCalled()
    expect(useAiChat.getState().expanded).toBe(false)
  })

  it('rejects pending review changes and collapses', () => {
    const ai = makeAi({ blockId: 'b1', status: 'user-reviewing' })
    useEditorStore.setState({ blockEditor: makeEditor(ai) })
    useAiChat.getState().toggle()
    expect(ai.rejectChanges).toHaveBeenCalledTimes(1)
    expect(ai.closeAIMenu).not.toHaveBeenCalled()
    expect(useAiChat.getState().expanded).toBe(false)
  })

  it('rejects on error state and collapses', () => {
    const ai = makeAi({ blockId: 'b1', status: 'error', error: new Error('boom') })
    useEditorStore.setState({ blockEditor: makeEditor(ai) })
    useAiChat.getState().toggle()
    expect(ai.rejectChanges).toHaveBeenCalledTimes(1)
    expect(useAiChat.getState().expanded).toBe(false)
  })
})