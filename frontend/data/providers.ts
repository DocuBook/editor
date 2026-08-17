/**
 * Provider catalog — MANUAL, single source of truth for the built-in
 * OpenAI-compatible endpoints (was: 7,300-line generated file from models.dev).
 *
 * Model lists are NOT hardcoded here — they are discovered at runtime from
 * each endpoint's `/models` (backend `list_models` command, keyed server-side).
 * Anything not listed — including aggregators/proxies (302.AI, OpenRouter) and
 * local gateways (e.g. opencode-go) — works via the Custom provider ("OpenAI
 * Compatible"): the user enters base URL + API key + model directly, no catalog
 * entry needed.
 *
 * Keep this list small, first-party and audited: every host must be in the
 * backend SSRF allowlist (src-tauri/agent/mod.rs ALLOWED_API_HOSTS) or requests fail.
 */
export interface ProviderInfo {
  id: string
  name: string
  /** OpenAI-compatible base URL. Empty = not usable from the catalog. */
  api: string
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'opencode-go', name: 'Opencode Go', api: 'http://localhost:1337/v1' },
  { id: 'anthropic', name: 'Anthropic', api: 'https://api.anthropic.com/v1' },
  { id: 'google', name: 'Google Gemini', api: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'deepseek', name: 'DeepSeek', api: 'https://api.deepseek.com' },
]
