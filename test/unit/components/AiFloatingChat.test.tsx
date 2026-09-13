// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Schema } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'

vi.mock('@blocknote/xl-ai', () => ({
  AIExtension: 'ai',
  getDefaultAIMenuItems: () => [
    { key: 'continue_writing', title: 'Continue writing', icon: null, onItemClick: vi.fn() },
    { key: 'summarize', title: 'Summarize', icon: null, onItemClick: vi.fn() },
  ],
}))

import AiFloatingChat from '../../../frontend/components/editor/AiFloatingChat'
import { useAiChat } from '../../../frontend/stores/aiChat'
import { useAiSettings } from '../../../frontend/stores/aiSettings'
import { useEditorStore } from '../../../frontend/stores/editor'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | null

function makeAi(aiMenuState: any = 'closed') {
  const listeners = new Set<() => void>()
  const store = {
    state: { aiMenuState },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  const setMenuState = (next: any) => {
    store.state.aiMenuState = next
    listeners.forEach(listener => listener())
  }
  return {
    store,
    setMenuState,
    openAIMenuAtBlock: vi.fn((blockId: string) => setMenuState({ blockId, status: 'user-input' })),
    closeAIMenu: vi.fn(() => setMenuState('closed')),
    acceptChanges: vi.fn(() => setMenuState('closed')),
    rejectChanges: vi.fn(() => setMenuState('closed')),
    abort: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn().mockResolvedValue(undefined),
    invokeAI: vi.fn().mockResolvedValue(undefined),
  }
}

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  root = createRoot(document.getElementById('root')!)
  useAiChat.setState({ expanded: false, input: '', focusRequest: 0 })
  useAiSettings.setState({ provider: 'openai', savedProviders: ['openai'] })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  useEditorStore.setState({ blockEditor: null })
  vi.clearAllMocks()
})

describe('AI floating composer', () => {
  it('stays visible, expands quick prompts, and changes its action to submit after input', () => {
    const ai = makeAi()
    useEditorStore.setState({
      blockEditor: {
        getExtension: vi.fn(() => ai),
        getTextCursorPosition: vi.fn(() => ({ block: { id: 'b1' } })),
        getSelection: vi.fn(() => undefined),
      },
    })

    act(() => root!.render(<AiFloatingChat />))

    const textarea = document.querySelector('textarea')!
    expect(textarea).not.toBeNull()
    expect(document.querySelector('[aria-label="Show AI prompts"]')).not.toBeNull()

    act(() => (document.querySelector('[aria-label="Show AI prompts"]') as HTMLButtonElement).click())
    expect(document.body.textContent).toContain('Continue writing')
    expect(document.body.textContent).toContain('Summarize')
    const floating = document.querySelector('.editor-ai-floating')!
    const promptAction = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Continue writing')!
    expect(floating.classList.contains('z-50')).toBe(true)
    expect(promptAction.classList.contains('ui-popover')).toBe(true)
    expect(promptAction.querySelector('span')?.classList.contains('text-accent')).toBe(true)

    act(() => promptAction.click())
    expect(document.body.textContent).not.toContain('Continue writing')

    act(() => (document.querySelector('[aria-label="Show AI prompts"]') as HTMLButtonElement).click())
    act(() => useAiChat.getState().focusInput('Tighten this paragraph'))
    expect(document.activeElement).toBe(textarea)
    expect(textarea.value).toBe('Tighten this paragraph')
    expect(document.body.textContent).not.toContain('Continue writing')

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Tighten this paragraph')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(document.body.textContent).not.toContain('Continue writing')
    const send = document.querySelector('[aria-label="Send prompt"]') as HTMLButtonElement
    expect(send).not.toBeNull()

    act(() => send.click())
    expect(ai.invokeAI).toHaveBeenCalledWith({ userPrompt: 'Tighten this paragraph', useSelection: false })
  })

  it('invokes AI in selection mode and never collapses the text selection', () => {
    const ai = makeAi()
    const setTextCursorPosition = vi.fn()
    const schema = new Schema({
      nodes: {
        doc: { content: 'block+' },
        paragraph: { content: 'text*', group: 'block' },
        text: { group: 'inline' },
      },
    })
    const doc = schema.node('doc', null, [schema.node('paragraph', null, schema.text('hello'))])
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, 1, 5) })
    const prosemirrorView = {
      get state() { return state },
      dispatch: vi.fn((tr) => { state = state.apply(tr) }),
    }
    const selectedBlocks = [{ id: 'last-selected' }]
    useEditorStore.setState({
      blockEditor: {
        document: selectedBlocks,
        prosemirrorView,
        getExtension: vi.fn(() => ai),
        getSelection: vi.fn(() => ({ blocks: selectedBlocks })),
        getSelectionCutBlocks: vi.fn(() => ({ blocks: selectedBlocks })),
        getTextCursorPosition: vi.fn(() => ({ block: { id: 'stale-block' } })),
        setTextCursorPosition,
      },
    })

    act(() => root!.render(<AiFloatingChat />))

    const textarea = document.querySelector('textarea')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Translate this')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => (document.querySelector('[aria-label="Send prompt"]') as HTMLButtonElement).click())

    expect(setTextCursorPosition).not.toHaveBeenCalled()
    expect(prosemirrorView.dispatch).toHaveBeenCalled()
    expect(ai.openAIMenuAtBlock).toHaveBeenCalledWith('last-selected')
    expect(ai.invokeAI).toHaveBeenCalledWith({ userPrompt: 'Translate this', useSelection: true })
  })

  it('syncs the stale cursor to an already-anchored block before invoking AI', () => {
    const ai = makeAi({ blockId: 'anchored', status: 'user-input' })
    const setTextCursorPosition = vi.fn()
    useEditorStore.setState({
      blockEditor: {
        getExtension: vi.fn(() => ai),
        getSelection: vi.fn(() => undefined),
        getTextCursorPosition: vi.fn(() => ({ block: { id: 'stale-first-block' } })),
        setTextCursorPosition,
      },
    })

    act(() => root!.render(<AiFloatingChat />))

    const textarea = document.querySelector('textarea')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Continue')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => (document.querySelector('[aria-label="Send prompt"]') as HTMLButtonElement).click())

    expect(setTextCursorPosition).not.toHaveBeenCalled()
    expect(ai.invokeAI).toHaveBeenCalledWith({ userPrompt: 'Continue', useSelection: false })
  })

  it('does not derive prompt visibility from xl-ai lifecycle state', () => {
    const ai = makeAi()
    useEditorStore.setState({
      blockEditor: {
        getExtension: vi.fn(() => ai),
        getTextCursorPosition: vi.fn(() => ({ block: { id: 'b1' } })),
        getSelection: vi.fn(() => undefined),
      },
    })

    act(() => root!.render(<AiFloatingChat />))
    act(() => ai.setMenuState({ blockId: 'b1', status: 'user-input' }))

    expect(useAiChat.getState().expanded).toBe(false)
    expect(document.body.textContent).not.toContain('Continue writing')
  })

  it.each([
    [{ blockId: 'b1', status: 'ai-writing' }, 'Stop'],
    [{ blockId: 'b1', status: 'user-reviewing' }, 'Accept'],
    [{ blockId: 'b1', status: 'user-reviewing' }, 'Revert'],
    [{ blockId: 'b1', status: 'error', error: new Error('boom') }, 'Retry'],
    [{ blockId: 'b1', status: 'error', error: new Error('boom') }, 'Cancel'],
  ])('collapses prompt actions before %s lifecycle action', (menuState, action) => {
    const ai = makeAi(menuState)
    useAiChat.setState({ expanded: true })
    useEditorStore.setState({
      blockEditor: {
        getExtension: vi.fn(() => ai),
        getTextCursorPosition: vi.fn(() => ({ block: { id: 'b1' } })),
        getSelection: vi.fn(() => undefined),
      },
    })

    act(() => root!.render(<AiFloatingChat />))
    const button = Array.from(document.querySelectorAll('button')).find(candidate => candidate.textContent?.trim() === action)!
    act(() => button.click())

    expect(useAiChat.getState().expanded).toBe(false)
    expect(document.body.textContent).not.toContain('Continue writing')
    expect(ai.openAIMenuAtBlock).not.toHaveBeenCalled()
  })

  it.each(['outside click', 'Escape'])('closes extended prompts on %s', (dismissal) => {
    const ai = makeAi()
    useEditorStore.setState({
      blockEditor: {
        getExtension: vi.fn(() => ai),
        getTextCursorPosition: vi.fn(() => ({ block: { id: 'b1' } })),
        getSelection: vi.fn(() => undefined),
      },
    })

    act(() => root!.render(<AiFloatingChat />))
    act(() => (document.querySelector('[aria-label="Show AI prompts"]') as HTMLButtonElement).click())
    expect(useAiChat.getState().expanded).toBe(true)

    act(() => {
      if (dismissal === 'Escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      else document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })

    expect(ai.closeAIMenu).toHaveBeenCalledTimes(1)
    expect(useAiChat.getState().expanded).toBe(false)
    expect(document.body.textContent).not.toContain('Continue writing')
  })

  it('keeps the FAB prompt list out of selection mode', () => {
    const ai = makeAi()
    useEditorStore.setState({
      blockEditor: {
        getExtension: vi.fn(() => ai),
        getSelection: vi.fn(() => ({ blocks: [{ id: 'selected' }] })),
        getTextCursorPosition: vi.fn(() => ({ block: { id: 'selected' } })),
      },
    })

    act(() => root!.render(<AiFloatingChat />))

    // Text-selection prompts live in the formatting toolbar popover instead.
    expect(useAiChat.getState().expanded).toBe(false)
    expect(document.body.textContent).not.toContain('Continue writing')
    expect(document.body.textContent).not.toContain('Summarize')
    expect(ai.openAIMenuAtBlock).not.toHaveBeenCalled()
    // The toggle is not a dead control in this mode: it is simply absent.
    expect(document.querySelector('[aria-label="Show AI prompts"]')).toBeNull()

    // A stale `expanded` flag must not resurrect the selection prompt list.
    act(() => useAiChat.setState({ expanded: true }))
    expect(document.body.textContent).not.toContain('Continue writing')
  })

  it('turns the trigger into send once a toolbar prompt fills the composer in selection mode', () => {
    const ai = makeAi()
    useEditorStore.setState({
      blockEditor: {
        getExtension: vi.fn(() => ai),
        getSelection: vi.fn(() => ({ blocks: [{ id: 'selected' }] })),
        getTextCursorPosition: vi.fn(() => ({ block: { id: 'selected' } })),
      },
    })

    act(() => root!.render(<AiFloatingChat />))
    act(() => useAiChat.getState().focusInput('Translate to English'))

    const textarea = document.querySelector('textarea')!
    expect(textarea.value).toBe('Translate to English')
    expect(document.activeElement).toBe(textarea)
    // Toolbar prompts append at the caret, so the caret sits at the end and the
    // box is scrolled to the last line instead of showing the first one.
    expect(textarea.selectionStart).toBe('Translate to English'.length)
    expect(textarea.selectionEnd).toBe('Translate to English'.length)
    expect(textarea.scrollTop).toBe(textarea.scrollHeight)
    expect(document.querySelector('[aria-label="Send prompt"]')).not.toBeNull()
    expect(document.querySelector('[aria-label="Show AI prompts"]')).toBeNull()
  })

  it('disables an unconfigured composer and points to API key settings', () => {
    const ai = makeAi()
    useAiSettings.setState({ provider: '', savedProviders: [] })
    useEditorStore.setState({
      blockEditor: {
        getExtension: vi.fn(() => ai),
        getTextCursorPosition: vi.fn(() => ({ block: { id: 'b1' } })),
        getSelection: vi.fn(() => undefined),
      },
    })

    act(() => root!.render(<AiFloatingChat />))

    const textarea = document.querySelector('textarea')!
    expect(textarea.disabled).toBe(true)
    expect(textarea.placeholder).toBe('Configure API key in Settings (⌘,)')
    expect(document.body.textContent).not.toContain('AI Ready')
    expect(document.body.textContent).not.toContain('AI Not Configured')
    expect((document.querySelector('[aria-label="Show AI prompts"]') as HTMLButtonElement).disabled).toBe(true)
  })
})
