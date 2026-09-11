// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  useAiChat.setState({ expanded: false, focusRequest: 0 })
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
    expect(promptAction.classList.contains('bg-surface')).toBe(true)
    expect(promptAction.classList.contains('border-border')).toBe(true)
    expect(promptAction.querySelector('span')?.classList.contains('text-accent')).toBe(true)

    act(() => promptAction.click())
    expect(document.body.textContent).not.toContain('Continue writing')

    act(() => (document.querySelector('[aria-label="Show AI prompts"]') as HTMLButtonElement).click())
    act(() => useAiChat.getState().focusInput())
    expect(document.activeElement).toBe(textarea)
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
