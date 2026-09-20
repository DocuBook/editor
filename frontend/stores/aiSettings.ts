import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { invoke } from '../lib/ipc'
import { PROVIDERS } from '../data/providers'

/** Payload of the backend `ai_settings` command — the server-side AI state that
 *  survives a browser/device switch. */
export interface BackendAiSettings {
  provider: string
  model: string
  savedProviders: string[]
  /** Bound custom-endpoint URL, when one is configured server-side. */
  baseUrl?: string
  /** Measured tool-call support per provider+model, persists across browsers. */
  probes?: Record<string, Record<string, boolean>>
}

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
      /** Restore the saved model, or use a valid bootstrap model so a new key can be validated before discovery. */
      setProvider: (p) => {
        set({ provider: p, apiKey: get().apiKeys[p] || '', model: get().models[p] || PROVIDERS.find(x => x.id === p)?.defaultModel || '' })
        scheduleMirror()
      },
      /** Save model per-provider so it survives provider switches. The selection
       *  is mirrored to the backend (see mirrorAiSelection) because localStorage
       *  alone cannot survive a browser/device change. */
      setModel: (m) => {
        set((s) => ({ model: m, models: { ...s.models, [s.provider]: m } }))
        scheduleMirror()
      },
      setApiKey: (key) => set((s) => ({ apiKey: key, apiKeys: { ...s.apiKeys, [s.provider]: key } })),
      /** Save the custom base URL per-provider (openai-compatible). Not secret — safe to persist. */
      setBaseUrl: (url) => set((s) => ({ baseUrls: { ...s.baseUrls, [s.provider]: url } })),
      /** Persist a test_connection probe result per provider+model (the probe is
       *  measured with a specific model — thinking-mode models can reject
       *  tool_choice:"required" while sibling models support tools). Also mirrored
       *  to the backend: re-measuring costs a round-trip, and a fresh browser would
       *  otherwise run text-only until every model re-probed. */
      setProbeTools: (provider, model, tools) => {
        set((s) => ({ probeTools: { ...s.probeTools, [provider]: { ...s.probeTools[provider], [model]: tools } } }))
        scheduleProbeMirror()
      },
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
       *  resolves it from the keychain on demand. */
      onRehydrateStorage: () => () => {
        // localStorage is per-origin and per-browser, so a new browser or device
        // starts with an empty store even though the backend still holds the key.
        // Pull the non-secret selection back from the server, which is the only
        // layer that survives that move.
        void hydrateAiSettings()
      },
    }
  )
)

/**
 * Restore provider/model from the backend after a localStorage miss.
 *
 * `savedProviders` grows by union: the backend is authoritative for what IT
 * knows (keychain / keys.json), but it cannot see a provider this browser
 * configured through a path the server does not track, and an empty `keys.json`
 * is not evidence that a provider was never configured. Replacing outright used
 * to disable the composer for a provider that was legitimately saved here.
 * `provider`/`model` are only adopted when local state
 * is empty, so a user who deliberately switched provider in this browser is not
 * yanked back to the server value on every reload.
 */
export async function hydrateAiSettings(): Promise<void> {
  const cfg = await fetchAiSettings()
  if (!cfg) return
  setSavedProviders(cfg.savedProviders)
  /** Adopting the server's own value must not be written back to it: mark the
   *  mirror as already in sync so a reload does not trigger a redundant write. */
  lastMirrored = `${cfg.provider}\u0000${cfg.model}`
  const st = useAiSettings.getState()
  /** Only adopt the server selection when this browser has none — otherwise a
   *  deliberate switch here would be reverted on every reload. */
  if (!st.provider && cfg.provider) st.setProvider(cfg.provider)
  if (!st.model && cfg.model) useAiSettings.setState({ model: cfg.model })
  /** Backend probes are authoritative for conflicts: another browser may have
   *  re-tested the same model after its key/endpoint changed. Keep only local
   *  entries that the backend does not know about, and never echo stale local
   *  values back as if they were the latest measurement. */
  const backendProbes = cfg.probes
  if (backendProbes) {
    useAiSettings.setState((s) => {
      const merged: Record<string, Record<string, boolean>> = { ...s.probeTools }
      for (const [provider, models] of Object.entries(backendProbes)) {
        merged[provider] = { ...merged[provider], ...models }
      }
      /** Hydration must not echo back to the backend (see lastMirrored). */
      lastMirroredProbes = probeSignature(merged)
      return { probeTools: merged }
    })
  }
  /** Custom endpoints keep their URL server-side (keys.json / keychain), so a
   *  fresh browser would otherwise have a provider but no reachable base URL. */
  if (cfg.baseUrl) {
    const provider = useAiSettings.getState().provider || cfg.provider
    if (provider) {
      useAiSettings.setState((s) => ({
        baseUrls: { ...s.baseUrls, [provider]: cfg.baseUrl as string },
      }))
    }
  }
}

/** Read the backend AI selection. Null when the command is unavailable (older
 *  backend, cold keychain) so callers fall back to local state. */
export async function fetchAiSettings(): Promise<BackendAiSettings | null> {
  try {
    const raw = await invoke<string>('ai_settings')
    const cfg = JSON.parse(raw) as Partial<BackendAiSettings>
    return {
      provider: typeof cfg.provider === 'string' ? cfg.provider : '',
      model: typeof cfg.model === 'string' ? cfg.model : '',
      savedProviders: Array.isArray(cfg.savedProviders)
        ? cfg.savedProviders.filter((id): id is string => typeof id === 'string')
        : [],
      baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : undefined,
      probes: isProbeMap(cfg.probes) ? cfg.probes : undefined,
    }
  } catch {
    return null
  }
}

/** Shape guard for the backend probe map: a malformed payload must not put
 *  non-boolean values into state, where `!== true` would silently mean text-only. */
function isProbeMap(value: unknown): value is Record<string, Record<string, boolean>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every(
    (models) =>
      !!models &&
      typeof models === 'object' &&
      !Array.isArray(models) &&
      Object.values(models as Record<string, unknown>).every((tools) => typeof tools === 'boolean'),
  )
}

/** Fold the providers the backend knows about into the local set.
 *
 *  Union, not replace: the two sources see different things. The server answers
 *  from keychain / keys.json (plus the bound custom endpoint), so a key saved in
 *  another browser shows up here; but the local set also carries providers this
 *  browser configured that the server has no record of. Replacement is not
 *  recoverable — dropping a provider flips `aiConfigured` false and disables the
 *  composer (`AiFloatingChat`), which looks like "AI broke" rather than a sync
 *  detail. Unconfiguring is an explicit user action (`removeSavedProvider`). */
export function setSavedProviders(ids: string[]): void {
  useAiSettings.setState((s) => ({ savedProviders: [...new Set([...s.savedProviders, ...ids])] }))
}

/** Mirror the current selection to the backend so it survives a storage wipe or
 *  a move to another browser/device. Fire-and-forget: a failed write degrades to
 *  today's behaviour (settings work here, just not everywhere). */
let lastMirrored = ''
export function mirrorAiSelection(): void {
  const { provider, model } = useAiSettings.getState()
  if (!provider) return
  const key = `${provider}\u0000${model}`
  if (key === lastMirrored) return
  lastMirrored = key
  void invoke('set_ai_settings', { provider, model }).catch(() => {
    /** Allow a later change to retry after a transient failure. */
    lastMirrored = ''
  })
}

/** Model ids are typed one keystroke at a time, so collapse a burst of edits into
 *  a single write instead of one per character. */
let mirrorTimer: ReturnType<typeof setTimeout> | undefined
function scheduleMirror(): void {
  if (mirrorTimer) clearTimeout(mirrorTimer)
  mirrorTimer = setTimeout(() => {
    mirrorTimer = undefined
    mirrorAiSelection()
  }, 500)
}

/** Stable comparison key for the probe map — probes have no natural single value
 *  to diff, so the serialization doubles as the change signal. */
function probeSignature(probes: Record<string, Record<string, boolean>>): string {
  return JSON.stringify(probes)
}

/** Mirror measured probes to the backend so they survive a browser/device change.
 *  Batched to one write, and a no-op when nothing changed — auto-probe can fire
 *  several times in a session and each write is a file rewrite. */
let lastMirroredProbes = ''
export function mirrorProbes(): void {
  const { probeTools } = useAiSettings.getState()
  const signature = probeSignature(probeTools)
  if (signature === lastMirroredProbes) return
  lastMirroredProbes = signature
  void invoke('set_probes', { probes: probeTools }).catch(() => {
    /** Allow a later change to retry after a transient failure. */
    lastMirroredProbes = ''
  })
}

/** Debounce probe mirrors: a save can land probe + selection in quick succession. */
let probeTimer: ReturnType<typeof setTimeout> | undefined
function scheduleProbeMirror(): void {
  if (probeTimer) clearTimeout(probeTimer)
  probeTimer = setTimeout(() => {
    probeTimer = undefined
    mirrorProbes()
  }, 500)
}
