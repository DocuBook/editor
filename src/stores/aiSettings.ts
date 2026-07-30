import { create } from 'zustand'
import { persist } from 'zustand/middleware'

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

/** Persisted AI settings. Saves to localStorage, keychain still holds API key for Rust. */
export const useAiSettings = create<AiSettingsState>()(
  persist(
    (set, get) => ({
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
    }),
    { name: 'docubook:ai-settings' }
  )
)
