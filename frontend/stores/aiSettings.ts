import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** Synthetic provider id for user-configured OpenAI-compatible endpoints — shared
 *  with SettingsModal and the Rust backend (agent::CUSTOM_PROVIDER_ID). */
export const CUSTOM_PROVIDER_ID = 'openai-compatible'

interface AiSettingsState {
  provider: string
  model: string
  apiKey: string
  savedProviders: string[]
  apiKeys: Record<string, string>
  models: Record<string, string>
  baseUrls: Record<string, string>
  /** Measured tool-call support per provider+model (from test_connection probe).
   *  Ground truth for whether OUR payload passes that gateway — no static
   *  exclusions; unmeasured providers/models default to the catalog's tool_call. */
  probeTools: Record<string, Record<string, boolean>>
  setProvider: (p: string) => void
  setModel: (m: string) => void
  setApiKey: (key: string) => void
  setBaseUrl: (url: string) => void
  setProbeTools: (provider: string, model: string, tools: boolean) => void
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
      baseUrls: {},
      probeTools: {},
      /** Restore per-provider apiKey + model (+ custom base URL) when switching providers. */
      setProvider: (p) => set({ provider: p, apiKey: get().apiKeys[p] || '', model: get().models[p] || '' }),
      /** Save model per-provider so it survives provider switches. */
      setModel: (m) => set((s) => ({ model: m, models: { ...s.models, [s.provider]: m } })),
      setApiKey: (key) => set((s) => ({ apiKey: key, apiKeys: { ...s.apiKeys, [s.provider]: key } })),
      /** Save the custom base URL per-provider (openai-compatible). Not secret — safe to persist. */
      setBaseUrl: (url) => set((s) => ({ baseUrls: { ...s.baseUrls, [s.provider]: url } })),
      /** Persist a test_connection probe result per provider+model (the probe is
       *  measured with a specific model — thinking-mode models can reject
       *  tool_choice:"required" while sibling models support tools). */
      setProbeTools: (provider, model, tools) => set((s) => ({ probeTools: { ...s.probeTools, [provider]: { ...s.probeTools[provider], [model]: tools } } })),
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
