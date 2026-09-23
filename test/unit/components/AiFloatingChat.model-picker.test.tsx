// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../frontend/utils/aiMenu', () => ({
  getDefaultAIMenuItems: () => [],
}))

vi.mock('../../../frontend/utils/modelDiscovery', () => ({
  fetchProviderModels: vi.fn(async (provider: string) => {
    if (provider === 'opencode-go') return [
      { id: 'deepseek-v4-flash', name: 'DS V4 Flash' },
      { id: 'deepseek-reasoner', name: 'DS Reasoner' },
    ]
    if (provider === 'deepseek') return [
      { id: 'deepseek-v4-flash', name: 'DS V4 Flash' },
      { id: 'deepseek-chat', name: 'DS Chat' },
    ]
    return []
  }),
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

async function settle() {
  await act(async () => { await Promise.resolve() })
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
})