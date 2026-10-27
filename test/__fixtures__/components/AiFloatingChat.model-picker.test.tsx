// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { settle } from '../harness'

vi.mock('../../../frontend/utils/aiMenu', () => ({
  getDefaultAIMenuItems: () => [],
}))

const { fetchProviderModels } = vi.hoisted(() => ({ fetchProviderModels: vi.fn() }))
const serveModels = async (provider: string) => {
    if (provider === 'opencode-go') return [
      { id: 'deepseek-v4-flash', name: 'DS V4 Flash' },
      { id: 'deepseek-reasoner', name: 'DS Reasoner' },
    ]
    if (provider === 'deepseek') return [
      { id: 'deepseek-v4-flash', name: 'DS V4 Flash' },
      { id: 'deepseek-chat', name: 'DS Chat' },
    ]
    return []
}
vi.mock('../../../frontend/utils/modelDiscovery', () => ({ fetchProviderModels }))
vi.mock('../../../frontend/utils/aiProbe', async importOriginal => ({
  ...await importOriginal<typeof import('../../../frontend/utils/aiProbe')>(),
  ensureToolProbe: vi.fn(async () => undefined),
}))

import AiFloatingChat from '../../../frontend/components/editor/AiFloatingChat'
import { useAiChat } from '../../../frontend/stores/aiChat'
import { useAiSettings, hydrateAiSettings } from '../../../frontend/stores/aiSettings'
import { useEditorStore } from '../../../frontend/stores/editor'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/** jsdom has no layout, so the dropdown's scroll-into-view is a no-op here. */
Element.prototype.scrollIntoView = () => {}

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
    openAIMenuAtBlock: vi.fn(() => setMenuState({ blockId: 'b1', status: 'user-input' })),
    closeAIMenu: vi.fn(() => setMenuState('closed')),
    acceptChanges: vi.fn(() => setMenuState('closed')),
    rejectChanges: vi.fn(() => setMenuState('closed')),
    abort: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn().mockResolvedValue(undefined),
    invokeAI: vi.fn().mockResolvedValue(undefined),
  }
}

beforeEach(() => {
  fetchProviderModels.mockImplementation(serveModels)
  useAiSettings.setState({ defaultModels: {}, dirtySelection: false })
  document.body.innerHTML = '<div id="root"></div>'
  root = createRoot(document.getElementById('root')!)
  useAiChat.setState({ expanded: false, input: '', focusRequest: 0, selectionPromptOpen: false })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  useEditorStore.setState({ blockEditor: null })
  Element.prototype.scrollIntoView = () => {}
  vi.clearAllMocks()
})

function renderComposer() {
  const ai = makeAi()
  useEditorStore.setState({
    blockEditor: {
      getExtension: vi.fn(() => ai),
      getTextCursorPosition: vi.fn(() => ({ block: { id: 'b1' } })),
      getSelection: vi.fn(() => undefined),
    },
  })
  act(() => root!.render(<AiFloatingChat />))
  return ai
}

function openPicker() {
  const trigger = document.querySelector('[aria-label="Select AI model"]') as HTMLButtonElement
  act(() => trigger.click())
}

async function pickModel(text: string) {
  openPicker()
  await settle()
  const rows = Array.from(document.querySelectorAll('#ai-model-listbox [role="option"]'))
  const row = rows.find((r) => r.textContent?.includes(text)) as HTMLButtonElement
  expect(row).toBeTruthy()
  act(() => row.click())
  await settle()
}

describe('composer model picker', () => {
  it('adopts the picked model for the active provider', async () => {
    useAiSettings.setState({
      provider: 'opencode-go',
      model: 'deepseek-v4-flash',
      savedProviders: ['opencode-go'],
      models: { 'opencode-go': 'deepseek-v4-flash' },
      baseUrls: { 'opencode-go': 'https://opencode.ai/zen/go/v1' },
    })
    renderComposer()

    await pickModel('deepseek-reasoner')

    expect(useAiSettings.getState().model).toBe('deepseek-reasoner')
    expect(useAiSettings.getState().provider).toBe('opencode-go')
    expect(document.querySelector('[aria-label="Select AI model"]')?.textContent).toContain('deepseek-reasoner')
    expect(document.querySelector('#ai-model-listbox')).toBeNull()
  })

  it('switches provider when a model from another provider is picked', async () => {
    useAiSettings.setState({
      provider: 'opencode-go',
      model: 'deepseek-v4-flash',
      savedProviders: ['opencode-go', 'deepseek'],
      models: { 'opencode-go': 'deepseek-v4-flash', deepseek: 'deepseek-v4-flash' },
      baseUrls: { 'opencode-go': 'https://opencode.ai/zen/go/v1', deepseek: 'https://api.deepseek.com' },
    })
    renderComposer()

    await pickModel('deepseek-chat')

    expect(useAiSettings.getState().provider).toBe('deepseek')
    expect(useAiSettings.getState().model).toBe('deepseek-chat')
  })

  it('highlights the active model and scrolls it into view when the picker opens', async () => {
    // The reported bug: with a long model list the active model sat below the
    // fold (max-h-64 + overflow-y-auto) with no highlight, so nothing pointed
    // at the current selection.
    const scrollSpy = vi.fn()
    Element.prototype.scrollIntoView = scrollSpy as unknown as typeof Element.prototype.scrollIntoView
    useAiSettings.setState({
      provider: 'opencode-go',
      model: 'deepseek-reasoner',
      savedProviders: ['opencode-go'],
      models: { 'opencode-go': 'deepseek-reasoner' },
      baseUrls: { 'opencode-go': 'https://opencode.ai/zen/go/v1' },
    })
    renderComposer()

    openPicker()
    await settle()

    const rows = Array.from(document.querySelectorAll('#ai-model-listbox [role="option"]')) as HTMLButtonElement[]
    const activeRow = rows.find((row) => row.getAttribute('aria-selected') === 'true')
    expect(activeRow?.textContent).toContain('deepseek-reasoner')
    expect(activeRow?.className).toContain('bg-accent')
    // The scroll-into-view lands on the active row, not the top of the list.
    expect(scrollSpy.mock.instances.at(-1)).toBe(activeRow)
  })

  it('survives a late hydration that still reports the backend active model', async () => {
    // The reported bug: the pick went back to the currently active model. The App
    // hydration retry loop can land AFTER the user picked (the retry exists
    // exactly for flaky boot hydrations), and it used to re-apply the backend's
    // stale active model over the session-local pick.
    useAiSettings.setState({
      provider: 'opencode-go',
      model: 'deepseek-v4-flash',
      savedProviders: ['opencode-go'],
      models: { 'opencode-go': 'deepseek-v4-flash' },
      baseUrls: { 'opencode-go': 'https://opencode.ai/zen/go/v1' },
    })
    renderComposer()

    await pickModel('deepseek-reasoner')
    expect(useAiSettings.getState().model).toBe('deepseek-reasoner')

    // A pending boot retry resolves with the backend still on the old model.
    const ipc = await import('../../../frontend/lib/ipc')
    const invokeSpy = vi.spyOn(ipc, 'invoke')
    invokeSpy.mockResolvedValue(JSON.stringify({
      active: 'opencode-go',
      endpoints: { 'opencode-go': { baseUrl: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4-flash', probes: {}, hasKey: true } },
      savedProviders: ['opencode-go'],
    }))
    await act(async () => { await hydrateAiSettings() })

    expect(useAiSettings.getState().model).toBe('deepseek-reasoner')
    expect(useAiSettings.getState().provider).toBe('opencode-go')
    // The data still refreshes: probes/baseUrls come from the backend.
    expect(useAiSettings.getState().baseUrls['opencode-go']).toBe('https://opencode.ai/zen/go/v1')
  })

  const rowsIn = (group: string) => {
    const header = Array.from(document.querySelectorAll('#ai-model-listbox [role="presentation"]')).find((node) => node.textContent === group)
    return Array.from(header?.closest('[role="group"]')?.querySelectorAll('[role="option"]') ?? []) as HTMLButtonElement[]
  }
  const groupNames = () => Array.from(document.querySelectorAll('#ai-model-listbox [role="group"]')).map((group) =>
    document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent)

  it('groups models under their provider instead of a badge per row', async () => {
    useAiSettings.setState({
      provider: 'opencode-go',
      model: 'deepseek-v4-flash',
      savedProviders: ['opencode-go', 'deepseek'],
      models: { 'opencode-go': 'deepseek-v4-flash', deepseek: 'deepseek-chat' },
      baseUrls: {},
    })
    renderComposer()
    openPicker()
    await settle()

    expect(groupNames()).toEqual(['Opencode Go', 'DeepSeek'])
    // A row is just the model id: no provider label inside it.
    expect(rowsIn('Opencode Go').map((row) => row.textContent)).toEqual(['deepseek-v4-flash', 'deepseek-reasoner'])
    expect(rowsIn('DeepSeek').map((row) => row.textContent)).toEqual(['deepseek-v4-flash', 'deepseek-chat'])
  })

  /** All three providers configured: every group lists its own endpoint's
   *  models, fetched with its own base URL, in the Settings page's order —
   *  even though the web server hands `savedProviders` over in a random order
   *  on every read (keys.json is a hash map). */
  it('lists all three configured providers, each from its own endpoint, in a stable order', async () => {
    fetchProviderModels.mockImplementation(async (provider: string) =>
      provider === 'openai-compatible' ? [{ id: 'custom-model', name: 'Custom' }] : serveModels(provider))
    const endpoints = {
      'openai-compatible': { baseUrl: 'https://kenari.id/v1', model: 'custom-model', probes: {}, hasKey: true },
      'opencode-go': { baseUrl: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4-flash', probes: {}, hasKey: true },
      deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', probes: {}, hasKey: true },
    }
    const ipc = await import('../../../frontend/lib/ipc')
    const invokeSpy = vi.spyOn(ipc, 'invoke')
    const hydrateWith = async (savedProviders: string[]) => {
      invokeSpy.mockResolvedValue(JSON.stringify({ active: 'opencode-go', endpoints, savedProviders }))
      await act(async () => { await hydrateAiSettings() })
    }
    renderComposer()

    for (const order of [['deepseek', 'openai-compatible', 'opencode-go'], ['opencode-go', 'deepseek', 'openai-compatible']]) {
      await hydrateWith(order)
      openPicker()
      await settle()

      expect(groupNames()).toEqual(['OpenAI Compatible', 'Opencode Go', 'DeepSeek'])
      expect(rowsIn('OpenAI Compatible').map((row) => row.textContent)).toEqual(['custom-model'])
      expect(rowsIn('Opencode Go').map((row) => row.textContent)).toEqual(['deepseek-v4-flash', 'deepseek-reasoner'])
      expect(rowsIn('DeepSeek').map((row) => row.textContent)).toEqual(['deepseek-v4-flash', 'deepseek-chat'])
      openPicker()
    }
    expect(fetchProviderModels).toHaveBeenCalledWith('openai-compatible', 'https://kenari.id/v1')
    expect(fetchProviderModels).toHaveBeenCalledWith('opencode-go', 'https://opencode.ai/zen/go/v1')
    expect(fetchProviderModels).toHaveBeenCalledWith('deepseek', 'https://api.deepseek.com')
    invokeSpy.mockRestore()
  })

  it('picks the provider of the group when two providers serve the same model id', async () => {
    useAiSettings.setState({
      provider: 'opencode-go',
      model: 'deepseek-v4-flash',
      savedProviders: ['opencode-go', 'deepseek'],
      models: { 'opencode-go': 'deepseek-v4-flash' },
      baseUrls: {},
    })
    renderComposer()
    openPicker()
    await settle()

    // Only the row under the active provider is marked active.
    expect(rowsIn('Opencode Go')[0].getAttribute('aria-selected')).toBe('true')
    expect(rowsIn('DeepSeek')[0].getAttribute('aria-selected')).toBe('false')
    act(() => rowsIn('DeepSeek')[0].click())
    await settle()
    expect(useAiSettings.getState().provider).toBe('deepseek')
    expect(useAiSettings.getState().model).toBe('deepseek-v4-flash')
  })

  it('lists only what the provider serves, not a model it dropped', async () => {
    useAiSettings.setState({
      provider: 'opencode-go',
      model: 'retired-model',
      savedProviders: ['opencode-go'],
      models: { 'opencode-go': 'retired-model' },
      defaultModels: { 'opencode-go': 'retired-model' },
      baseUrls: {},
    })
    renderComposer()
    openPicker()
    await settle()

    expect(rowsIn('Opencode Go').map((row) => row.textContent)).toEqual(['deepseek-v4-flash', 'deepseek-reasoner'])
  })

  it('falls back to the backend default model, not a session pick, when a list cannot be fetched', async () => {
    fetchProviderModels.mockImplementation(async (provider: string) => {
      if (provider === 'deepseek') throw new Error('offline')
      return serveModels(provider)
    })
    useAiSettings.setState({
      provider: 'deepseek',
      model: 'session-pick',
      savedProviders: ['opencode-go', 'deepseek'],
      models: { deepseek: 'session-pick' },
      defaultModels: { deepseek: 'deepseek-chat' },
      baseUrls: {},
    })
    renderComposer()
    openPicker()
    await settle()

    expect(rowsIn('DeepSeek').map((row) => row.textContent)).toEqual(['deepseek-chat'])
    expect(document.querySelector('#ai-model-listbox')?.textContent).toContain('Could not load models')
    // The provider that answered is unaffected by the one that failed.
    expect(rowsIn('Opencode Go')).toHaveLength(2)
  })

  it('refetches on every open and ignores a slower reply from an earlier open', async () => {
    let answerFirst!: (models: { id: string; name: string }[]) => void
    fetchProviderModels.mockImplementationOnce(() => new Promise((resolve) => { answerFirst = resolve }))
    fetchProviderModels.mockImplementationOnce(async () => [{ id: 'current-model', name: 'Current' }])
    useAiSettings.setState({
      provider: 'opencode-go',
      model: 'current-model',
      savedProviders: ['opencode-go'],
      models: { 'opencode-go': 'current-model' },
      baseUrls: {},
    })
    renderComposer()
    openPicker()
    openPicker()
    openPicker()
    await settle()
    answerFirst([{ id: 'stale-model', name: 'Stale' }])
    await settle()

    expect(fetchProviderModels).toHaveBeenCalledTimes(2)
    expect(rowsIn('Opencode Go').map((row) => row.textContent)).toEqual(['current-model'])
  })

  describe('search', () => {
    /** 8 + 6 = 14 models across two providers: over the threshold of 10. */
    const serveMany = async (provider: string) => provider === 'opencode-go'
      ? ['glm-5', 'kimi-k2', 'qwen3-coder', 'deepseek-v4-flash', 'deepseek-reasoner', 'minimax-m2', 'gpt-oss-120b', 'llama-4-scout'].map((id) => ({ id, name: id }))
      : ['deepseek-chat', 'deepseek-v4-flash', 'deepseek-coder', 'deepseek-math', 'deepseek-vl', 'deepseek-r2'].map((id) => ({ id, name: id }))
    const configureTwo = () => useAiSettings.setState({
      provider: 'opencode-go',
      model: 'glm-5',
      savedProviders: ['opencode-go', 'deepseek'],
      models: { 'opencode-go': 'glm-5', deepseek: 'deepseek-chat' },
      baseUrls: {},
    })
    const searchBox = () => document.querySelector<HTMLInputElement>('input[aria-label="Search models"]')
    const type = (value: string) => act(() => {
      const input = searchBox()!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const press = (key: string) => act(() => {
      searchBox()!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    })
    const optionTexts = () => Array.from(document.querySelectorAll('#ai-model-listbox [role="option"]')).map((row) => row.textContent)

    it('shows no search box for a short list', async () => {
      configureTwo()
      renderComposer()
      openPicker()
      await settle()

      // serveModels: 2 + 2 models — scanning beats typing.
      expect(optionTexts()).toHaveLength(4)
      expect(searchBox()).toBeNull()
    })

    it('shows a search box over ten models and filters across every provider', async () => {
      fetchProviderModels.mockImplementation(serveMany)
      configureTwo()
      renderComposer()
      openPicker()
      await settle()

      expect(optionTexts()).toHaveLength(14)
      expect(searchBox()).not.toBeNull()
      // Outside the listbox: a combobox input is not a valid listbox child.
      expect(searchBox()!.closest('[role="listbox"]')).toBeNull()
      expect(searchBox()!.getAttribute('aria-controls')).toBe('ai-model-listbox')

      type('V4')
      // Case-insensitive, and the same id under both providers stays in both groups.
      expect(groupNames()).toEqual(['Opencode Go', 'DeepSeek'])
      expect(optionTexts()).toEqual(['deepseek-v4-flash', 'deepseek-v4-flash'])

      type('coder')
      expect(groupNames()).toEqual(['Opencode Go', 'DeepSeek'])
      expect(optionTexts()).toEqual(['qwen3-coder', 'deepseek-coder'])

      type('math')
      // A group without a match is hidden rather than left as an empty header.
      expect(groupNames()).toEqual(['DeepSeek'])

      type('no-such-model')
      expect(optionTexts()).toEqual([])
      expect(document.querySelector('#ai-model-listbox')!.textContent).toContain('No matching models')
    })

    it('Enter picks the first match, arrows move the highlight first', async () => {
      fetchProviderModels.mockImplementation(serveMany)
      configureTwo()
      renderComposer()
      openPicker()
      await settle()

      type('coder')
      // Typing highlights the first match and points the combobox at it.
      expect(searchBox()!.getAttribute('aria-activedescendant')).toBe('ai-model-option-0')
      press('ArrowDown')
      expect(searchBox()!.getAttribute('aria-activedescendant')).toBe('ai-model-option-1')
      press('Enter')
      await settle()

      // The second match belongs to DeepSeek, so the pick switches provider too.
      expect(useAiSettings.getState().provider).toBe('deepseek')
      expect(useAiSettings.getState().model).toBe('deepseek-coder')
      expect(document.querySelector('#ai-model-listbox')).toBeNull()

      openPicker()
      await settle()
      // A fresh open starts unfiltered.
      expect(searchBox()!.value).toBe('')
      expect(optionTexts()).toHaveLength(14)
      type('glm')
      press('Enter')
      await settle()
      expect(useAiSettings.getState().provider).toBe('opencode-go')
      expect(useAiSettings.getState().model).toBe('glm-5')
    })

    it('Escape closes only the model picker, not the composer', async () => {
      fetchProviderModels.mockImplementation(serveMany)
      configureTwo()
      const ai = renderComposer()
      openPicker()
      await settle()
      type('deep')

      act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
      await settle()

      expect(document.querySelector('#ai-model-listbox')).toBeNull()
      expect(document.activeElement).toBe(document.querySelector('[aria-label="Select AI model"]'))
      expect(ai.closeAIMenu).not.toHaveBeenCalled()
      // The selection is untouched.
      expect(useAiSettings.getState().model).toBe('glm-5')
    })

    it('holds Escape back while the search box is composing', async () => {
      fetchProviderModels.mockImplementation(serveMany)
      configureTwo()
      const ai = renderComposer()
      openPicker()
      await settle()

      // Android IMEs deliver the strip-cancel Escape with isComposing: false.
      act(() => { searchBox()!.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) })
      act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
      await settle()

      expect(document.querySelector('#ai-model-listbox')).not.toBeNull()
      expect(ai.closeAIMenu).not.toHaveBeenCalled()
    })

    it('carries the full model id in a tooltip on the truncated trigger and rows', async () => {
      const long = 'accounts/fireworks/models/qwen3-coder-480b-a35b-instruct'
      useAiSettings.setState({ provider: 'opencode-go', model: long, savedProviders: ['opencode-go'], models: { 'opencode-go': long }, baseUrls: {} })
      fetchProviderModels.mockImplementation(async () => [{ id: long, name: long }])
      renderComposer()

      const trigger = document.querySelector('[aria-label="Select AI model"]')!
      expect(trigger.getAttribute('title')).toContain(long)
      expect(trigger.querySelector('span')!.className).toMatch(/\btruncate\b/)
      openPicker()
      await settle()
      expect(document.querySelector('#ai-model-listbox [role="option"]')!.getAttribute('title')).toBe(long)
    })
  })

  describe('placement and height', () => {
    it('stacks inside the composer card above the prompt, like the status bar', async () => {
      useAiSettings.setState({ provider: 'opencode-go', model: 'deepseek-v4-flash', savedProviders: ['opencode-go'], models: { 'opencode-go': 'deepseek-v4-flash' }, baseUrls: {} })
      renderComposer()
      openPicker()
      await settle()

      const listbox = document.querySelector('#ai-model-listbox')!
      const surface = document.querySelector('.ai-chat-surface')!
      const prompt = document.querySelector('textarea[aria-label="AI prompt"]')!
      // In the card, not a popover floating over it…
      expect(surface.contains(listbox)).toBe(true)
      const positioned: Element[] = []
      for (let node = listbox.parentElement; node && node !== surface; node = node.parentElement) {
        if (node.classList.contains('absolute')) positioned.push(node)
      }
      expect(positioned).toEqual([])
      // …and above the prompt in document order.
      expect(listbox.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('fits the list into the visual viewport and re-fits when the keyboard opens', async () => {
      /** Card: bottom edge at 700px, 300px tall, of which the list is 200px —
       *  so 100px of the card is everything else (prompt, toolbar). */
      const viewport = Object.assign(new EventTarget(), { offsetTop: 0, height: 900 })
      Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
      const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        return (this.classList.contains('ai-chat-surface') ? { top: 400, bottom: 700, height: 300, left: 0, right: 300, width: 300, x: 0, y: 400 } : { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0, x: 0, y: 0 }) as DOMRect
      })
      const offset = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return this.id === 'ai-model-listbox' ? 200 : 0
      })
      try {
        useAiSettings.setState({ provider: 'opencode-go', model: 'deepseek-v4-flash', savedProviders: ['opencode-go'], models: { 'opencode-go': 'deepseek-v4-flash' }, baseUrls: {} })
        renderComposer()
        openPicker()
        await settle()
        const cap = () => (document.querySelector('#ai-model-listbox') as HTMLElement).style.maxHeight

        // Plenty of room above the card: the 16rem cap.
        expect(cap()).toBe('256px')

        // Keyboard up: only 400px visible, the card's bottom (700) is behind it.
        // Room = 400 − 56 (tab bar) − 100 (rest of the card) = 244.
        viewport.height = 400
        act(() => { viewport.dispatchEvent(new Event('resize')) })
        expect(cap()).toBe('244px')

        // A landscape phone with the keyboard up: never below three rows.
        viewport.height = 200
        act(() => { viewport.dispatchEvent(new Event('resize')) })
        expect(cap()).toBe('96px')

        // Keyboard down again: back to the cap.
        viewport.height = 900
        act(() => { viewport.dispatchEvent(new Event('resize')) })
        expect(cap()).toBe('256px')
      } finally {
        rect.mockRestore()
        offset.mockRestore()
        delete (window as { visualViewport?: unknown }).visualViewport
      }
    })
  })
})
