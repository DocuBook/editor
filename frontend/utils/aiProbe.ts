/**
 * AI tool-call probe resolution & auto-probing.
 *
 * The probe (test_connection) measures whether OUR applyDocumentOperations
 * payload passes a gateway — per provider+model, because thinking-mode models
 * can reject tool_choice:"required" while siblings support tools.
 *
 * Rules this module owns:
 * 1. Env-controlled custom endpoints (DB_OPENAI_COMPAT_*): the probe is keyed
 *    by the ENV model (the one the backend actually uses), not whatever the UI
 *    happens to hold.
 * 2. Unmeasured means text-only, for every provider. A newly selected model —
 *    a composer pick, a Settings save, a hydrated selection — is therefore
 *    measured by `ensureToolProbe`, one request per provider+model at a time,
 *    so the transport never silently runs a tool-capable model as text-only.
 */
import { invoke } from '../lib/ipc'
import { CUSTOM_PROVIDER_ID, useAiSettings } from '../stores/aiSettings'

/** Resolve the model that should own the probe for a provider.
 *  Custom env endpoints: the env model wins (backend uses it regardless of UI). */
export function resolveProbeModel(
  provider: string,
  uiModel: string,
  envModel?: string,
): string {
  if (provider === CUSTOM_PROVIDER_ID && envModel) return envModel
  return uiModel
}

/** Resolve the model the transport actually sends for a provider.
 *  Mirrors getAiConfig + Editor.tsx resolution (env custom model overrides). */
export function resolveRequestModel(
  provider: string,
  uiModel: string,
  envModel?: string,
): string {
  return resolveProbeModel(provider, uiModel, envModel)
}

/** Whether a provider+model is text-only (no tool calls) given probe state. The
 *  probe is the SINGLE source of truth for every provider (the generated catalog's
 *  toolCall flag is gone): unmeasured → text-only until auto-probe measures true. */
export function isTextOnly(
  provider: string,
  model: string,
  probeTools: Record<string, Record<string, boolean>>,
): boolean {
  const probe = model ? probeTools[provider]?.[model] : undefined
  return probe !== true
}

/** Tool support from a test_connection reply. `undefined` means the probe was
 *  inconclusive (rate limit, gateway outage) and must not be stored: storing a
 *  `false` there would demote the model to text-only for good. */
export function parseProbeResult(raw: unknown): boolean | undefined {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return typeof parsed?.tools === 'boolean' ? parsed.tools : undefined
  } catch {
    return undefined
  }
}

/** Forget recent probe failures (tests, and a Settings save that just proved
 *  the key works). */
export function resetToolProbeBackoff(): void {
  probeFailedAt.clear()
}

/** Store a probe result in the UI state AND on the backend, unless the provider
 *  was revoked while the probe ran — a late write would otherwise recreate the
 *  revoked endpoint's probe row. Backend failure is non-fatal: the local record
 *  still holds until the next successful write. */
export async function recordToolProbe(provider: string, model: string, tools: boolean): Promise<void> {
  if (!useAiSettings.getState().savedProviders.includes(provider)) return
  useAiSettings.getState().setProbeTools(provider, model, tools)
  try {
    await invoke('set_probe', { provider, model, tools })
  } catch { /* probe stays local until the next successful write */ }
}

const probesInFlight = new Map<string, Promise<boolean | undefined>>()
/** After a probe that measured nothing (offline, rate limited, gateway down),
 *  the pair is left alone for a while: every prompt would otherwise wait on a
 *  fresh probe against the same failing gateway. */
const PROBE_RETRY_AFTER_MS = 60_000
const probeFailedAt = new Map<string, number>()

/** Measured tool support for a configured provider+model, probing it once when
 *  unmeasured. Concurrent callers (the composer pick, the Settings form, the
 *  transport) share one request per pair. The probe runs with the backend's
 *  stored key and endpoint (empty key/URL), so it measures exactly what chat
 *  will send. Resolves `undefined` when the pair cannot be measured now. */
export function ensureToolProbe(provider: string, model: string): Promise<boolean | undefined> {
  const state = useAiSettings.getState()
  const known = model ? state.probeTools[provider]?.[model] : undefined
  if (known !== undefined) return Promise.resolve(known)
  if (!provider || !model || !state.savedProviders.includes(provider)) return Promise.resolve(undefined)
  const key = `${provider}\u0000${model}`
  const pending = probesInFlight.get(key)
  if (pending) return pending
  const failedAt = probeFailedAt.get(key)
  if (failedAt !== undefined && Date.now() - failedAt < PROBE_RETRY_AFTER_MS) return Promise.resolve(undefined)
  const probe = (async () => {
    try {
      const tools = parseProbeResult(await invoke<string>('test_connection', { provider, model, baseUrl: '', apiKey: '' }))
      if (tools === undefined) probeFailedAt.set(key, Date.now())
      else {
        probeFailedAt.delete(key)
        await recordToolProbe(provider, model, tools)
      }
      return tools
    } catch {
      probeFailedAt.set(key, Date.now())
      return undefined
    } finally {
      probesInFlight.delete(key)
    }
  })()
  probesInFlight.set(key, probe)
  return probe
}
