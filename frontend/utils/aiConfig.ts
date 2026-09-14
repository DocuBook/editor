/**
 * Resolve the saved AI provider/model/base URL for a Rust `ask_ai` call.
 *
 * The API key is deliberately NOT returned — the backend resolves it from the
 * keychain (SEC-5). Shared by the document transport (aiTransport) and the
 * commit-message generator so both read the same persisted settings.
 */
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
    const p = st.provider
      ? PROVIDERS.find((x) => x.id === st.provider)
      : undefined;
    /** Custom OpenAI-compatible endpoints aren't in the catalog — their base URL
     *  lives in the store and is bound server-side at save time. */
    const baseUrl =
      p?.api ||
      (st.provider === CUSTOM_PROVIDER_ID
        ? st.baseUrls[st.provider]
        : undefined);
    let envModel: string | undefined;
    if (st.provider === CUSTOM_PROVIDER_ID) {
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
      provider: st.provider || undefined,
      model: resolveRequestModel(st.provider, st.model, envModel) || undefined,
      baseUrl,
    };
  } catch {
    console.error("[ai] getAiConfig failed");
    return {};
  }
}
