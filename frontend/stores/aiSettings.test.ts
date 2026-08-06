import { beforeEach, describe, expect, it, vi } from 'vitest'

// Node test env has no window/localStorage, but zustand persist looks up
// `window.localStorage` (its getter throws in node and persist silently
// disables itself). Stub a Map-backed storage so the REAL store is
// exercised — not a copy.
const storage = new Map<string, string>()
const ls = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => { storage.set(k, v) },
  removeItem: (k: string) => { storage.delete(k) },
  clear: () => storage.clear(),
}
vi.stubGlobal('localStorage', ls)
vi.stubGlobal('window', { localStorage: ls })

const { useAiSettings } = await import('./aiSettings')

const DEFAULTS = {
  provider: '',
  model: '',
  apiKey: '',
  savedProviders: [],
  apiKeys: {},
  models: {},
}

describe('aiSettings store', () => {
  beforeEach(() => {
    useAiSettings.setState(DEFAULTS)
  })

  it('starts with empty defaults', () => {
    const s = useAiSettings.getState()
    expect(s.provider).toBe('')
    expect(s.model).toBe('')
    expect(s.apiKey).toBe('')
    expect(s.savedProviders).toEqual([])
    expect(s.apiKeys).toEqual({})
    expect(s.models).toEqual({})
  })

  it('setModel saves per-provider and restores on provider switch', () => {
    useAiSettings.getState().setProvider('openai')
    useAiSettings.getState().setModel('gpt-5.6')
    expect(useAiSettings.getState().model).toBe('gpt-5.6')
    expect(useAiSettings.getState().models['openai']).toBe('gpt-5.6')

    // switch to another provider, pick a different model
    useAiSettings.getState().setProvider('anthropic')
    expect(useAiSettings.getState().model).toBe('')
    useAiSettings.getState().setModel('opus-5')
    expect(useAiSettings.getState().models['anthropic']).toBe('opus-5')

    // switch back — last model for openai is restored, not defaulted to cheapest
    useAiSettings.getState().setProvider('openai')
    expect(useAiSettings.getState().model).toBe('gpt-5.6')

    useAiSettings.getState().setProvider('anthropic')
    expect(useAiSettings.getState().model).toBe('opus-5')
  })

  it('setProvider restores model only when previously saved', () => {
    useAiSettings.getState().setProvider('groq')
    expect(useAiSettings.getState().model).toBe('')
  })

  it('setProvider loads apiKey from apiKeys', () => {
    useAiSettings.getState().setProvider('openai')
    useAiSettings.getState().setApiKey('sk-openai')
    useAiSettings.getState().setProvider('mistral')
    expect(useAiSettings.getState().apiKey).toBe('')

    useAiSettings.getState().setApiKey('sk-mistral')
    useAiSettings.getState().setProvider('openai')
    expect(useAiSettings.getState().apiKey).toBe('sk-openai')

    useAiSettings.getState().setProvider('mistral')
    expect(useAiSettings.getState().apiKey).toBe('sk-mistral')
  })

  it('setApiKey saves per-provider and sets current apiKey', () => {
    useAiSettings.getState().setProvider('openai')
    useAiSettings.getState().setApiKey('sk-1')
    expect(useAiSettings.getState().apiKey).toBe('sk-1')
    expect(useAiSettings.getState().apiKeys['openai']).toBe('sk-1')
  })

  it('setApiKey does not leak keys across providers', () => {
    useAiSettings.getState().setProvider('openai')
    useAiSettings.getState().setApiKey('sk-openai')

    useAiSettings.getState().setProvider('mistral')
    useAiSettings.getState().setApiKey('sk-mistral')

    expect(useAiSettings.getState().provider).toBe('mistral')
    expect(useAiSettings.getState().apiKeys['openai']).toBe('sk-openai')
    expect(useAiSettings.getState().apiKeys['mistral']).toBe('sk-mistral')
    expect(useAiSettings.getState().apiKey).toBe('sk-mistral')
  })

  it('clearApiKey removes key from apiKeys', () => {
    useAiSettings.getState().setProvider('openai')
    useAiSettings.getState().setApiKey('sk-1')
    expect(useAiSettings.getState().apiKeys['openai']).toBe('sk-1')

    useAiSettings.getState().clearApiKey('openai')
    expect(useAiSettings.getState().apiKeys['openai']).toBeUndefined()
    expect(useAiSettings.getState().apiKey).toBe('')
  })

  it('clearApiKey only clears current apiKey when matching provider', () => {
    useAiSettings.getState().setProvider('openai')
    useAiSettings.getState().setApiKey('sk-openai')

    useAiSettings.getState().setProvider('mistral')
    useAiSettings.getState().setApiKey('sk-mistral')

    // Clear mistral (current provider)
    useAiSettings.getState().clearApiKey('mistral')
    expect(useAiSettings.getState().apiKey).toBe('')
    expect(useAiSettings.getState().apiKeys['openai']).toBe('sk-openai')
    expect(useAiSettings.getState().apiKeys['mistral']).toBeUndefined()
  })

  it('clearApiKey does not clear current apiKey for different provider', () => {
    useAiSettings.getState().setProvider('openai')
    useAiSettings.getState().setApiKey('sk-openai')

    useAiSettings.getState().setProvider('mistral')
    useAiSettings.getState().setApiKey('sk-mistral')

    // Clear openai (non-current provider)
    useAiSettings.getState().clearApiKey('openai')
    expect(useAiSettings.getState().apiKey).toBe('sk-mistral')
    expect(useAiSettings.getState().apiKeys['openai']).toBeUndefined()
    expect(useAiSettings.getState().apiKeys['mistral']).toBe('sk-mistral')
  })

  it('addSavedProvider and removeSavedProvider', () => {
    useAiSettings.getState().addSavedProvider('openai')
    expect(useAiSettings.getState().savedProviders).toEqual(['openai'])

    useAiSettings.getState().addSavedProvider('mistral')
    expect(useAiSettings.getState().savedProviders).toEqual(['openai', 'mistral'])

    useAiSettings.getState().removeSavedProvider('openai')
    expect(useAiSettings.getState().savedProviders).toEqual(['mistral'])
  })

  it('addSavedProvider deduplicates', () => {
    useAiSettings.getState().addSavedProvider('openai')
    useAiSettings.getState().addSavedProvider('openai')
    expect(useAiSettings.getState().savedProviders).toEqual(['openai'])
  })

  it('setModel updates model', () => {
    useAiSettings.getState().setModel('gpt-4o')
    expect(useAiSettings.getState().model).toBe('gpt-4o')
    useAiSettings.getState().setModel('claude-3')
    expect(useAiSettings.getState().model).toBe('claude-3')
  })

  it('setProvider with no stored apiKey defaults to empty', () => {
    useAiSettings.getState().setProvider('unknown')
    expect(useAiSettings.getState().apiKey).toBe('')
  })

  it('never persists apiKey or apiKeys to storage', () => {
    useAiSettings.getState().setProvider('openai')
    useAiSettings.getState().setApiKey('sk-secret-42')
    const persisted = storage.get('docubook:ai-settings')
    expect(persisted).toBeDefined()
    expect(persisted).not.toContain('sk-secret-42')
    expect(persisted).not.toContain('apiKey')
  })

  it('full lifecycle: type key, switch providers, revoke', () => {
    useAiSettings.getState().setProvider('openai')
    useAiSettings.getState().setApiKey('sk-aaa')
    expect(useAiSettings.getState().apiKey).toBe('sk-aaa')
    expect(useAiSettings.getState().apiKeys['openai']).toBe('sk-aaa')

    useAiSettings.getState().setProvider('anthropic')
    expect(useAiSettings.getState().apiKey).toBe('')

    useAiSettings.getState().setApiKey('sk-bbb')
    expect(useAiSettings.getState().apiKey).toBe('sk-bbb')
    expect(useAiSettings.getState().apiKeys['openai']).toBe('sk-aaa')
    expect(useAiSettings.getState().apiKeys['anthropic']).toBe('sk-bbb')

    useAiSettings.getState().setProvider('openai')
    expect(useAiSettings.getState().apiKey).toBe('sk-aaa')

    useAiSettings.getState().clearApiKey('openai')
    expect(useAiSettings.getState().apiKeys['openai']).toBeUndefined()
    expect(useAiSettings.getState().apiKey).toBe('')
  })
})
