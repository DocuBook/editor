import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface AiSettingsState {
  provider: string
  model: string
  apiKey: string
  savedProviders: string[]
  apiKeys: Record<string, string>
  models: Record<string, string>
  setProvider: (p: string) => void
  setModel: (m: string) => void
  setApiKey: (key: string) => void
  clearApiKey: (providerId: string) => void
  addSavedProvider: (id: string) => void
  removeSavedProvider: (id: string) => void
}

/** Persisted AI settings. apiKey excluded from localStorage — always fetched from keychain via backend. */
export const useAiSettings = create<AiSettingsState>()(
  persist(
    (set, get) => ({
      provider: '',
      model: '',
      apiKey: '',
      savedProviders: [],
      apiKeys: {},
      models: {},
      /** Restore per-provider apiKey + model when switching providers. */
      setProvider: (p) => set({ provider: p, apiKey: get().apiKeys[p] || '', model: get().models[p] || '' }),
      /** Save model per-provider so it survives provider switches. */
      setModel: (m) => set((s) => ({ model: m, models: { ...s.models, [s.provider]: m } })),
      setApiKey: (key) => set((s) => ({ apiKey: key, apiKeys: { ...s.apiKeys, [s.provider]: key } })),
      clearApiKey: (pid) => set((s) => { const { [pid]: _, ...rest } = s.apiKeys; return { apiKeys: rest, ...(s.provider === pid ? { apiKey: '' } : {}) } }),
      addSavedProvider: (id) => set({ savedProviders: [...new Set([...get().savedProviders, id])] }),
      removeSavedProvider: (id) => set({ savedProviders: get().savedProviders.filter(x => x !== id) }),
    }),
    {
      name: 'docubook:ai-settings',
      partialize: (state) => {
        const { apiKey: _, apiKeys: __, ...safe } = state
        return safe
      },
      /** API key is NOT persisted and never read from the webview — the backend
       *  resolves it from the keychain on demand (SEC-5). */
      onRehydrateStorage: () => () => {},
    }
  )
)
