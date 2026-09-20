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
    /** Custom OpenAI-compatible endpoints aren't in the catalog — their base URL
     *  lives in the store and is bound server-side at save time. The backend is
     *  only consulted when the store lost it (fresh browser), never per send. */
    let baseUrl = p?.api;
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
