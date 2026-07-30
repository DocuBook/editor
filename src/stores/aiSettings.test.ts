import { describe, it, expect, beforeEach } from 'vitest'

// Create a minimal store mock without persist middleware for testing
import { create } from 'zustand'

interface AiSettingsState {
  provider: string
  model: string
  apiKey: string
  savedProviders: string[]
  apiKeys: Record<string, string>
  setProvider: (p: string) => void
  setModel: (m: string) => void
  setApiKey: (key: string) => void
  clearApiKey: (providerId: string) => void
  addSavedProvider: (id: string) => void
  removeSavedProvider: (id: string) => void
}

const createStore = () =>
  create<AiSettingsState>()((set, get) => ({
    provider: '',
    model: '',
    apiKey: '',
    savedProviders: [],
    apiKeys: {},
    setProvider: (p) => set({ provider: p, apiKey: get().apiKeys[p] || '' }),
    setModel: (m) => set({ model: m }),
    setApiKey: (key) => set((s) => ({ apiKey: key, apiKeys: { ...s.apiKeys, [s.provider]: key } })),
    clearApiKey: (pid) => set((s) => { const { [pid]: _, ...rest } = s.apiKeys; return { apiKeys: rest, ...(s.provider === pid ? { apiKey: '' } : {}) } }),
    addSavedProvider: (id) => set({ savedProviders: [...new Set([...get().savedProviders, id])] }),
    removeSavedProvider: (id) => set({ savedProviders: get().savedProviders.filter(x => x !== id) }),
  }))

describe('aiSettings store', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    store = createStore()
  })

  it('starts with empty defaults', () => {
    const s = store.getState()
    expect(s.provider).toBe('')
    expect(s.model).toBe('')
    expect(s.apiKey).toBe('')
    expect(s.savedProviders).toEqual([])
    expect(s.apiKeys).toEqual({})
  })

  it('setProvider loads apiKey from apiKeys', () => {
    store.getState().setProvider('openai')
    store.getState().setApiKey('sk-openai')
    store.getState().setProvider('mistral')
    expect(store.getState().apiKey).toBe('')

    store.getState().setApiKey('sk-mistral')
    store.getState().setProvider('openai')
    expect(store.getState().apiKey).toBe('sk-openai')

    store.getState().setProvider('mistral')
    expect(store.getState().apiKey).toBe('sk-mistral')
  })

  it('setApiKey saves per-provider and sets current apiKey', () => {
    store.getState().setProvider('openai')
    store.getState().setApiKey('sk-1')
    expect(store.getState().apiKey).toBe('sk-1')
    expect(store.getState().apiKeys['openai']).toBe('sk-1')
  })

  it('setApiKey does not leak keys across providers', () => {
    store.getState().setProvider('openai')
    store.getState().setApiKey('sk-openai')

    store.getState().setProvider('mistral')
    store.getState().setApiKey('sk-mistral')

    expect(store.getState().provider).toBe('mistral')
    expect(store.getState().apiKeys['openai']).toBe('sk-openai')
    expect(store.getState().apiKeys['mistral']).toBe('sk-mistral')
    expect(store.getState().apiKey).toBe('sk-mistral')
  })

  it('clearApiKey removes key from apiKeys', () => {
    store.getState().setProvider('openai')
    store.getState().setApiKey('sk-1')
    expect(store.getState().apiKeys['openai']).toBe('sk-1')

    store.getState().clearApiKey('openai')
    expect(store.getState().apiKeys['openai']).toBeUndefined()
    expect(store.getState().apiKey).toBe('')
  })

  it('clearApiKey only clears current apiKey when matching provider', () => {
    store.getState().setProvider('openai')
    store.getState().setApiKey('sk-openai')

    store.getState().setProvider('mistral')
    store.getState().setApiKey('sk-mistral')

    // Clear mistral (current provider)
    store.getState().clearApiKey('mistral')
    expect(store.getState().apiKey).toBe('')
    expect(store.getState().apiKeys['openai']).toBe('sk-openai')
    expect(store.getState().apiKeys['mistral']).toBeUndefined()
  })

  it('clearApiKey does not clear current apiKey for different provider', () => {
    store.getState().setProvider('openai')
    store.getState().setApiKey('sk-openai')

    store.getState().setProvider('mistral')
    store.getState().setApiKey('sk-mistral')

    // Clear openai (non-current provider)
    store.getState().clearApiKey('openai')
    expect(store.getState().apiKey).toBe('sk-mistral')
    expect(store.getState().apiKeys['openai']).toBeUndefined()
    expect(store.getState().apiKeys['mistral']).toBe('sk-mistral')
  })

  it('addSavedProvider and removeSavedProvider', () => {
    store.getState().addSavedProvider('openai')
    expect(store.getState().savedProviders).toEqual(['openai'])

    store.getState().addSavedProvider('mistral')
    expect(store.getState().savedProviders).toEqual(['openai', 'mistral'])

    store.getState().removeSavedProvider('openai')
    expect(store.getState().savedProviders).toEqual(['mistral'])
  })

  it('addSavedProvider deduplicates', () => {
    store.getState().addSavedProvider('openai')
    store.getState().addSavedProvider('openai')
    expect(store.getState().savedProviders).toEqual(['openai'])
  })

  it('setModel updates model', () => {
    store.getState().setModel('gpt-4o')
    expect(store.getState().model).toBe('gpt-4o')
    store.getState().setModel('claude-3')
    expect(store.getState().model).toBe('claude-3')
  })

  it('setProvider with no stored apiKey defaults to empty', () => {
    store.getState().setProvider('unknown')
    expect(store.getState().apiKey).toBe('')
  })

  it('full lifecycle: type key, switch providers, revoke', () => {
    store.getState().setProvider('openai')
    store.getState().setApiKey('sk-aaa')
    expect(store.getState().apiKey).toBe('sk-aaa')
    expect(store.getState().apiKeys['openai']).toBe('sk-aaa')

    store.getState().setProvider('anthropic')
    expect(store.getState().apiKey).toBe('')

    store.getState().setApiKey('sk-bbb')
    expect(store.getState().apiKey).toBe('sk-bbb')
    expect(store.getState().apiKeys['openai']).toBe('sk-aaa')
    expect(store.getState().apiKeys['anthropic']).toBe('sk-bbb')

    store.getState().setProvider('openai')
    expect(store.getState().apiKey).toBe('sk-aaa')

    store.getState().clearApiKey('openai')
    expect(store.getState().apiKeys['openai']).toBeUndefined()
    expect(store.getState().apiKey).toBe('')
  })
})
