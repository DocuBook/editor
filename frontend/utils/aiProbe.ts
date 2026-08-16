/**
 * AI tool-call probe resolution & auto-probing.
 *
 * The probe (test_connection) measures whether OUR applyDocumentOperations
 * payload passes a gateway — per provider+model, because thinking-mode models
 * can reject tool_choice:"required" while siblings support tools.
 *
 * Two gaps this closes:
 * 1. Env-controlled custom endpoints (DB_OPENAI_COMPAT_*): the probe must be
 *    keyed by the ENV model (the one the backend actually uses), not whatever
 *    the UI happens to hold.
 * 2. Model switches: a newly selected model has no probe yet. Catalog providers
 *    default permissively (toolCall unless measured false), but custom endpoints
 *    are text-only until probed true — so switching models silently drops tool
 *    calls until a manual Test. Auto-probe in the background.
 */
import { CUSTOM_PROVIDER_ID } from '../stores/aiSettings'

export interface ProbeState {
  probeTools: Record<string, Record<string, boolean>>
  setProbeTools: (provider: string, model: string, tools: boolean) => void
}

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

/** Whether a provider+model is text-only (no tool calls) given probe state. */
export function isTextOnly(
  provider: string,
  model: string,
  probeTools: Record<string, Record<string, boolean>>,
  catalogToolCall: boolean,
): boolean {
  const probe = model ? probeTools[provider]?.[model] : undefined
  if (provider === CUSTOM_PROVIDER_ID) return probe !== true // text-only until measured true
  return catalogToolCall === true && probe === false
}

/**
 * Auto-probe a provider+model if it has no stored probe yet. No-op when a probe
 * already exists (avoids re-testing on every render/mount). Errors are silent —
 * the badge stays at the default and Test remains available.
 */
export async function autoProbe(
  provider: string,
  model: string,
  probeTools: Record<string, Record<string, boolean>>,
  setProbeTools: (p: string, m: string, tools: boolean) => void,
  runProbe: () => Promise<{ tools: boolean } | undefined>,
): Promise<void> {
  if (!provider || !model) return
  if (probeTools[provider]?.[model] !== undefined) return // already measured
  try {
    const result = await runProbe()
    if (result && result.tools !== undefined) {
      setProbeTools(provider, model, result.tools)
    }
  } catch { /* silent — badge stays at default */ }
}
