import { create } from 'zustand'
import { invoke } from '../lib/ipc'
import { PROVIDERS } from '../data/providers'

/** Synthetic provider id for user-configured OpenAI-compatible endpoints — shared
 *  with SettingsModal and the Rust backend (agent::CUSTOM_PROVIDER_ID). */
export const CUSTOM_PROVIDER_ID = 'openai-compatible'

/** One configured provider as the backend reports it (`ai_settings.endpoints`). */
export interface BackendEndpoint {
  baseUrl: string
  model: string
  /** Measured tool-call support per model. Empty = not measured yet. */
  probes: Record<string, boolean>
  /** Whether the backend holds a key for this provider. The key itself is never
   *  sent to the webview (SEC-5: keys are backend-only). */
  hasKey: boolean
}

/** Env-var override of the custom provider (DB_OPENAI_COMPAT_*). Present only
 *  when the backend is forced by the environment — then its fields are
 *  read-only and no Revoke is offered, because the backend rejects edits. */
export interface BackendEnvConfig {
  baseUrl: string
  model: string
  hasKey: boolean
}

/** Payload of the backend `ai_settings` command — the SINGLE source of truth for
 *  AI connection data (provider, model, base URL, probes). The browser holds a
 *  copy for rendering; it never writes config.json on its own. */
export interface BackendAiSettings {
  /** Provider chat uses. */
  active: string
  /** Every configured provider, multi-endpoint: several are valid at once. */
  endpoints: Record<string, BackendEndpoint>
  savedProviders: string[]
  env?: BackendEnvConfig
}

interface AiSettingsState {
  provider: string
  model: string
  /** Transient key input for the REPLACE path only — key replacement goes through
   *  set_api_key. Never persisted anywhere, never read back from the backend. */
  apiKey: string
  savedProviders: string[]
  apiKeys: Record<string, string>
  models: Record<string, string>
  baseUrls: Record<string, string>
  /** Measured tool-call support per provider+model (from test_connection probe).
   *  Ground truth for whether OUR payload passes that gateway — no static
   *  exclusions; unmeasured providers/models are treated as text-only. */
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

/** UI state for AI settings. No persist middleware: `config.json` on the backend
 *  is the only store, and the browser renders what `hydrateAiSettings()` fetched.
 *  Persisting here would make localStorage a second, competing source of truth —
 *  the exact bug where a fresh browser showed empty fields for a configured
 *  provider. */
export const useAiSettings = create<AiSettingsState>()((set, get) => ({
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
  },
  /** Save model per-provider so it survives provider switches. Writing it to the
   *  backend is the caller's job (explicit Save / Test), never an implicit mirror. */
  setModel: (m) => set((s) => ({ model: m, models: { ...s.models, [s.provider]: m } })),
  setApiKey: (key) => set((s) => ({ apiKey: key, apiKeys: { ...s.apiKeys, [s.provider]: key } })),
  /** Save the custom base URL per-provider (openai-compatible). Not secret — and
   *  only ever a local render value here; the backend owns the persisted copy. */
  setBaseUrl: (url) => set((s) => ({ baseUrls: { ...s.baseUrls, [s.provider]: url } })),
  /** Record a test_connection probe result per provider+model (the probe is
   *  measured with a specific model — thinking-mode models can reject
   *  tool_choice:"required" while sibling models support tools). Persisting it
   *  server-side is an explicit `set_probe` invoke owned by the caller. */
  setProbeTools: (provider, model, tools) => {
    set((s) => ({ probeTools: { ...s.probeTools, [provider]: { ...s.probeTools[provider], [model]: tools } } }))
  },
  clearApiKey: (pid) => set((s) => { const { [pid]: _, ...rest } = s.apiKeys; return { apiKeys: rest, ...(s.provider === pid ? { apiKey: '' } : {}) } }),
  addSavedProvider: (id) => set({ savedProviders: [...new Set([...get().savedProviders, id])] }),
  removeSavedProvider: (id) => set({ savedProviders: get().savedProviders.filter(x => x !== id) }),
}))

/**
 * Load the full AI configuration from the backend and SET it as the UI state.
 *
 * A full set, not "adopt only if empty": the server is authoritative for what is
 * configured, so a browser that could not reach the backend on boot (or was
 * hydrated before a provider was saved elsewhere) must end up with the server's
 * values rather than keeping an empty local snapshot forever.
 */
export async function hydrateAiSettings(): Promise<void> {
  const cfg = await fetchAiSettings()
  if (!cfg) return
  useAiSettings.setState(applyBackendSettings(cfg))
}

/** Map the backend payload onto store state. Pure so it can be reasoned about
 *  (and tested) without the async command around it. */
function applyBackendSettings(cfg: BackendAiSettings): Partial<AiSettingsState> {
  const models: Record<string, string> = {}
  const baseUrls: Record<string, string> = {}
  const probeTools: Record<string, Record<string, boolean>> = {}
  for (const [provider, endpoint] of Object.entries(cfg.endpoints)) {
    models[provider] = endpoint.model
    if (endpoint.baseUrl) baseUrls[provider] = endpoint.baseUrl
    probeTools[provider] = { ...endpoint.probes }
  }
  /** `savedProviders` is the server list verbatim: it is derived from the keys the
   *  backend actually holds, so a browser-local provider the server does not know
   *  no longer exists as a concept — `endpoints` is the same set by construction. */
  const active = cfg.active || cfg.savedProviders[0] || ''
  /** A payload that carries no selection at all (the backend always sends one
   *  once anything is configured) must not clear the provider the user has open
   *  — only the DATA is authoritative there, not the absence of a selection. */
  const currentProvider = active || useAiSettings.getState().provider
  /** Env-controlled custom endpoints: the base URL the backend will use is the
   *  env one, so what the UI renders must be what the transport sends. */
  if (cfg.env) {
    baseUrls[CUSTOM_PROVIDER_ID] = cfg.env.baseUrl
    models[CUSTOM_PROVIDER_ID] = cfg.env.model
  }
  /** Model precedence, most authoritative first: the endpoint the server names as
   *  active, then anything the server has for the selected provider, then the
   *  catalog's bootstrap model (the local-selection path). What a browser last
   *  PICKED is deliberately not consulted: on a fresh session that pick is gone
   *  anyway, and preferring it here would describe a model that is not the one
   *  being sent. */
  const model = models[active]
    || models[currentProvider]
    || PROVIDERS.find(x => x.id === currentProvider)?.defaultModel
    || ''
  return { provider: cfg.active || currentProvider, model, savedProviders: cfg.savedProviders, models, baseUrls, probeTools }
}

/** Read the backend AI configuration. Null when the command is unavailable
 *  (older backend) or the payload is not a usable settings object: a `null`/array
 *  body, a non-JSON body, or an `endpoints`/`active` pair of the wrong type must
 *  not be folded into empty state, because empty state LOOKS authoritative (it
 *  renders as "no provider configured") and would wipe what is on screen. */
export async function fetchAiSettings(): Promise<BackendAiSettings | null> {
  try {
    const raw = await invoke<string>('ai_settings')
    const cfg = JSON.parse(raw)
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null
    const settings = cfg as Record<string, unknown>
    const endpoints = settings.endpoints
    if (!endpoints || typeof endpoints !== 'object' || Array.isArray(endpoints)) return null
    if (settings.active !== undefined && typeof settings.active !== 'string') return null
    if (settings.savedProviders !== undefined && !Array.isArray(settings.savedProviders)) return null
    /** A malformed ENDPOINT rejects the whole payload rather than being skipped:
     *  dropping one entry would look authoritative for that provider ("not
     *  configured") and unlock fields that the server still holds a key for. */
    const parsed: Record<string, BackendEndpoint> = {}
    for (const [provider, value] of Object.entries(endpoints as Record<string, unknown>)) {
      const endpoint = parseEndpoint(value)
      if (!endpoint) return null
      parsed[provider] = endpoint
    }
    return {
      active: typeof settings.active === 'string' ? settings.active : '',
      endpoints: parsed,
      savedProviders: Array.isArray(settings.savedProviders)
        ? settings.savedProviders.filter((id): id is string => typeof id === 'string')
        : [],
      env: parseEnv(settings.env),
    }
  } catch {
    return null
  }
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

/** Shape guard for one endpoint. Model and URL are rendered into inputs, so a
 *  non-string would surface as "[object Object]" in the settings form. */
function parseEndpoint(value: unknown): BackendEndpoint | null {
  const raw = value
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const endpoint = raw as Record<string, unknown>
  return {
    baseUrl: typeof endpoint.baseUrl === 'string' ? endpoint.baseUrl : '',
    model: typeof endpoint.model === 'string' ? endpoint.model : '',
    probes: parseProbeMap(endpoint.probes),
    hasKey: endpoint.hasKey === true,
  }
}

/** Shape guard for a probe map: a malformed payload must not put non-boolean
 *  values into state, where `!== true` would silently mean text-only. */
function parseProbeMap(value: unknown): Record<string, boolean> {
  const probes: Record<string, boolean> = {}
  for (const [model, tools] of Object.entries(parseRecord(value))) {
    if (typeof tools === 'boolean') probes[model] = tools
  }
  return probes
}

function parseEnv(value: unknown): BackendEnvConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const env = value as Record<string, unknown>
  return {
    baseUrl: typeof env.baseUrl === 'string' ? env.baseUrl : '',
    model: typeof env.model === 'string' ? env.model : '',
    hasKey: env.hasKey === true,
  }
}

/** Replace the configured-provider list with the server's. The server derives it
 *  from the keys and endpoints it actually holds, so it is authoritative — a
 *  union with local entries would resurrect a provider that was revoked here or
 *  in another browser. */
export function setSavedProviders(ids: string[]): void {
  useAiSettings.setState({ savedProviders: [...new Set(ids)] })
}
