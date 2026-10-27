import { create } from 'zustand'
import { invoke } from '../lib/ipc'
import { PROVIDERS } from '../data/providers'

/** Synthetic provider id for user-configured OpenAI-compatible endpoints — shared
 *  with SettingsPane and the Rust backend (agent::CUSTOM_PROVIDER_ID). */
export const CUSTOM_PROVIDER_ID = 'openai-compatible'

/** The order providers are listed in everywhere — the Settings page's order:
 *  the custom endpoint first, then the catalog. */
const PROVIDER_ORDER = [CUSTOM_PROVIDER_ID, ...PROVIDERS.map(p => p.id)]

/** A provider list in PROVIDER_ORDER, deduplicated; ids outside it go last,
 *  alphabetically. The web server derives `savedProviders` from a hash map that
 *  iterates in a fresh random order on every read, so taken verbatim the
 *  composer's provider groups reshuffled on each hydration (window focus), and
 *  the `savedProviders[0]` fallback picked a different provider each time. */
export function orderProviders(ids: string[]): string[] {
  const rank = (id: string) => {
    const index = PROVIDER_ORDER.indexOf(id)
    return index === -1 ? PROVIDER_ORDER.length : index
  }
  return [...new Set(ids)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

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
  /** Each configured provider's DEFAULT model, exactly as the backend holds it
   *  (the endpoint saved in Settings, or the env model). Written only from a
   *  backend payload — hydration, or the re-read after a Settings save/revoke —
   *  never by a composer pick: it is the one fallback when a provider's live
   *  model list cannot be fetched. */
  defaultModels: Record<string, string>
  /** True once the composer has picked a model this session. Composer picks are
   *  session-local (the backend is only told on an explicit Settings save), so a
   *  repeat/delayed hydration must preserve the live selection instead of
   *  re-applying the backend's stale active model. */
  dirtySelection: boolean
  setProvider: (p: string) => void
  /** Save a model against the provider it BELONGS to. The provider is an explicit
   *  argument, not `s.provider` at call time: keying on the current provider made
   *  the write order-dependent, so any caller that set the model before switching
   *  provider filed it under the wrong one. */
  setModel: (provider: string, model: string) => void
  setApiKey: (key: string) => void
  setBaseUrl: (url: string) => void
  setProbeTools: (provider: string, model: string, tools: boolean) => void
  clearApiKey: (providerId: string) => void
  addSavedProvider: (id: string) => void
  removeSavedProvider: (id: string) => void
  /** A TOTAL revoke has to leave nothing of the provider behind: dropping only the
   *  key would leave its saved model (and base URL) in state, which the form then
   *  feeds back into the now-unlocked Model field — spelling out the endpoint the
   *  user just revoked and re-validating the next save against it. */
  forgetProvider: (providerId: string) => void
  markSelectionDirty: () => void
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
  defaultModels: {},
  dirtySelection: false,
  /** Switch provider, keeping whatever model THIS provider already had. No
   *  catalog fallback: models are discovered at runtime, so an unconfigured
   *  provider stays empty until the composer picker sets one (a baked-in default
   *  was a guess that resolved to a model the provider does not serve). */
  setProvider: (p) => set({ provider: p, apiKey: get().apiKeys[p] || '', model: get().models[p] || '' }),
  /** Save model per-provider so it survives provider switches. Writing it to the
   *  backend is the caller's job (explicit Save / Test), never an implicit mirror. */
  setModel: (provider, model) => set((s) => ({
    models: { ...s.models, [provider]: model },
    /** Live selection follows only when the write is FOR the active provider: a
     *  background write for another provider (a late hydration, a probe for a form
     *  the user is not looking at) must not yank the composer off the live pick. */
    ...(s.provider === provider ? { model } : {}),
  })),
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
  forgetProvider: (pid) => set((s) => {
    /** Every per-provider row, dropped together in ONE write: the list, the key
     *  buffer, the model and the base URL are one provider's state, so clearing
     *  them piecemeal is how a stale model outlived its key. */
    const { [pid]: _key, ...apiKeys } = s.apiKeys
    const { [pid]: _model, ...models } = s.models
    const { [pid]: _url, ...baseUrls } = s.baseUrls
    const { [pid]: _probes, ...probeTools } = s.probeTools
    const { [pid]: _default, ...defaultModels } = s.defaultModels
    return {
      apiKeys, models, baseUrls, probeTools, defaultModels,
      savedProviders: s.savedProviders.filter(x => x !== pid),
      ...(s.provider === pid ? { provider: '', model: '', apiKey: '' } : {}),
    }
  }),
  markSelectionDirty: () => set({ dirtySelection: true }),
}))

/**
 * Load the full AI configuration from the backend and SET it as the UI state.
 *
 * A full set, not "adopt only if empty": the server is authoritative for what is
 * configured, so a browser that could not reach the backend on boot (or was
 * hydrated before a provider was saved elsewhere) must end up with the server's
 * values rather than keeping an empty local snapshot forever.
 */
export async function hydrateAiSettings(): Promise<boolean> {
  const cfg = await fetchAiSettings()
  if (!cfg) return false
  useAiSettings.setState(applyBackendSettings(cfg))
  for (const listener of aiSettingsHydrationListeners) listener(cfg)
  return true
}

type AiSettingsHydrationListener = (settings: BackendAiSettings) => void
const aiSettingsHydrationListeners = new Set<AiSettingsHydrationListener>()

/** Notify mounted settings forms when the app-root refresh gets a fresh payload.
 *  The forms keep local lock/input state, so updating the store alone cannot make
 *  an already-mounted form reflect a change made in another tab. */
export function subscribeAiSettingsHydration(listener: AiSettingsHydrationListener): () => void {
  aiSettingsHydrationListeners.add(listener)
  return () => aiSettingsHydrationListeners.delete(listener)
}

/** The per-provider rows of a backend payload, mapped ONCE for every consumer:
 *  hydration applies them together with the selection, a Settings save/revoke
 *  adopts them alone (`adoptBackendEndpoints`). */
function backendEndpointRows(cfg: BackendAiSettings) {
  const models: Record<string, string> = {}
  const baseUrls: Record<string, string> = {}
  const probeTools: Record<string, Record<string, boolean>> = {}
  for (const [provider, endpoint] of Object.entries(cfg.endpoints)) {
    models[provider] = endpoint.model
    if (endpoint.baseUrl) baseUrls[provider] = endpoint.baseUrl
    probeTools[provider] = { ...endpoint.probes }
  }
  /** Env-controlled custom endpoints: the base URL the backend will use is the
   *  env one, so what the UI renders must be what the transport sends. */
  if (cfg.env) {
    baseUrls[CUSTOM_PROVIDER_ID] = cfg.env.baseUrl
    models[CUSTOM_PROVIDER_ID] = cfg.env.model
  }
  const defaultModels = Object.fromEntries(Object.entries(models).filter(([, value]) => !!value))
  return { models, baseUrls, probeTools, defaultModels }
}

/** Apply ONLY the per-provider data of a payload the caller already fetched: the
 *  saved list, every provider's stored model and base URL, and the default models.
 *  A saved live selection is left alone — a composer pick is newer than any
 *  fetch; an empty or unsaved one adopts `cfg.active` (see below) — and so is
 *  the probe map: `recordToolProbe` writes the store before the
 *  backend, so a payload fetched before that write landed would erase a fresh
 *  measurement. ProviderForm calls this after its save/revoke re-read, because
 *  hydration runs from the app root on boot and window focus only: without it a
 *  provider saved this session had no default model in the store, so the picker
 *  had no fallback row for it until the window was next refocused. */
export function adoptBackendEndpoints(cfg: BackendAiSettings): void {
  const { models, baseUrls, defaultModels } = backendEndpointRows(cfg)
  const savedProviders = [...new Set(cfg.savedProviders)]
  /** The selection is adopted ONLY when there is none to protect: the live
   *  provider is empty (first-ever save) or no longer configured. A save makes
   *  the saved provider active server-side, but leaving the store on '' kept the
   *  composer disabled — "configure AI first" right after configuring it — until
   *  a window focus happened to re-hydrate. A live pick always names a saved
   *  provider, so it never falls into this branch. */
  const live = useAiSettings.getState()
  const stale = !live.provider || !savedProviders.includes(live.provider)
  const selection = stale && cfg.active && savedProviders.includes(cfg.active)
    ? { provider: cfg.active, model: models[cfg.active] || '' }
    : {}
  useAiSettings.setState({ savedProviders, models, baseUrls, defaultModels, ...selection })
}

/** Map the backend payload onto store state. Pure so it can be reasoned about
 *  (and tested) without the async command around it. */
function applyBackendSettings(cfg: BackendAiSettings): Partial<AiSettingsState> {
  const { models, baseUrls, probeTools, defaultModels } = backendEndpointRows(cfg)
  /** `savedProviders` is the server list verbatim: it is derived from the keys the
   *  backend actually holds, so a browser-local provider the server does not know
   *  no longer exists as a concept — `endpoints` is the same set by construction. */
  const active = cfg.active || cfg.savedProviders[0] || ''
  /** A payload that carries no selection at all (the backend always sends one
   *  once anything is configured) must not clear the provider the user has open
   *  — only the DATA is authoritative there, not the absence of a selection. */
  const currentProvider = active || useAiSettings.getState().provider
  /** Model precedence, most authoritative first: the endpoint the server names as
   *  active, then anything the server has for the selected provider. Nothing else
   *  — a catalog bootstrap model no longer exists (a hardcoded id the provider may
   *  not serve), so a provider with no stored model hydrates as blank and the
   *  composer picker resolves it through discovery. What a browser last PICKED is
   *  deliberately not consulted either: on a fresh session that pick is gone
   *  anyway, and preferring it here would describe a model that is not the one
   *  being sent. */
  const model = models[active]
    || models[currentProvider]
    || ''
  /** Composer picks are session-local (Settings Save is what tells the backend), so
   *  a repeat/delayed hydration — the App retry loop exists precisely because a
   *  later attempt can land after the user already took over — must preserve the
   *  live provider+model instead of re-applying the backend's stale active model.
   *  Only the SELECTION is preserved: endpoints, savedProviders and probes below
   *  stay authoritative, and a fresh session (no pick yet) always adopts the
   *  server's values. */
  const live = useAiSettings.getState()
  const preserveSelection = live.dirtySelection && !!live.provider && !!live.model
  return {
    provider: preserveSelection ? live.provider : cfg.active || currentProvider,
    model: preserveSelection ? live.model : model,
    savedProviders: cfg.savedProviders,
    models,
    defaultModels,
    baseUrls,
    probeTools,
  }
}

/** Single-flight for the BURST case only: three ProviderForm instances mount from
 *  one page open, and boot retry + window focus can land together, so the same
 *  read used to fire three times. Callers that overlap share one request.
 *
 *  Deliberately NOT a cache: the promise is dropped the moment it settles, so the
 *  next call reads the backend fresh. A cache here would let a stale payload drive
 *  the lock state machine — the dangerous direction, since a wrong "configured"
 *  unlocks fields the server still holds a key for. Per-instance form state is
 *  untouched: each form still holds only the lock state it renders. */
let settingsInFlight: Promise<BackendAiSettings | null> | null = null

export async function fetchAiSettingsShared(): Promise<BackendAiSettings | null> {
  if (settingsInFlight) return settingsInFlight
  settingsInFlight = fetchAiSettings().finally(() => { settingsInFlight = null })
  return settingsInFlight
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
        ? orderProviders(settings.savedProviders.filter((id): id is string => typeof id === 'string'))
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
