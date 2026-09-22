import { invoke } from '../lib/ipc'
import { useAiSettings, CUSTOM_PROVIDER_ID } from '../stores/aiSettings'
import { PROVIDERS } from '../data/providers'
import { resolveRequestModel } from './aiProbe'

export interface AiConfig {
  provider?: string
  model?: string
  baseUrl?: string
}

export async function getAiConfig(): Promise<AiConfig> {
  try {
    const st = useAiSettings.getState();
    const provider = st.provider;
    const model = st.model;
    const p = provider
      ? PROVIDERS.find((x) => x.id === provider)
      : undefined;
    /** Base URL resolution order: the store (hydrated from the backend's
     *  endpoints, which own the persisted value) wins; the catalog entry is only
     *  a default for a provider the backend has no URL for. Custom endpoints get
     *  one extra step — the env override, which is what the backend actually
     *  sends — and never a per-send backend round-trip. */
    let baseUrl = st.baseUrls[provider] || p?.api;
    if (provider === CUSTOM_PROVIDER_ID) {
      baseUrl = st.baseUrls[provider] || (await customBaseUrl()) || undefined;
    }
    let envModel: string | undefined;
    if (provider === CUSTOM_PROVIDER_ID) {
      try {
        const raw = await invoke<string>("custom_ai_config");
        const config = JSON.parse(raw);
        if (config?.source === "env" && typeof config.model === "string")
          envModel = config.model;
      } catch {
        /** Backward compatibility: older backends or unavailable config keep the saved model. */
      }
    }
    return {
      provider: provider || undefined,
      model: resolveRequestModel(provider, model, envModel) || undefined,
      baseUrl,
    };
  } catch {
    console.error("[ai] getAiConfig failed");
    return {};
  }
}

/** The server-bound custom endpoint URL, or null when not configured. */
async function customBaseUrl(): Promise<string | null> {
  try {
    const raw = await invoke<string>("custom_ai_config");
    const config = JSON.parse(raw) as { baseUrl?: unknown };
    return typeof config?.baseUrl === "string" && config.baseUrl ? config.baseUrl : null;
  } catch {
    return null;
  }
}
