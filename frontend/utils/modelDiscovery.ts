/**
 * Runtime model discovery — replaces the generated provider catalog's model
 * lists. The backend `list_models` command calls `GET {baseUrl}/models` with
 * the stored key (frontend never holds keys, SEC-5), SSRF-guarded + no
 * redirects. Never cached: the composer's picker lists what the provider
 * serves right now, so a model the provider dropped is not offered and one it
 * added shows up on the next open.
 */
import { invoke } from '../lib/ipc'

export interface DiscoveredModel {
  id: string
  name: string
}

/** `apiKey` is optional: the composer discovers with the STORED key, while the
 *  settings form may pass a key the user just typed but has not saved yet — the
 *  one case where discovery must run before the backend knows the key. */
export async function fetchProviderModels(provider: string, baseUrl: string, apiKey?: string): Promise<DiscoveredModel[]> {
  const models = JSON.parse(await invoke<string>('list_models', { provider, baseUrl, ...(apiKey ? { apiKey } : {}) })) as DiscoveredModel[]
  // Dedupe by id — some /models endpoints return the same id with different
  // casing/duplicates, which breaks React list keys (duplicate-key warning).
  const seen = new Set<string>()
  const unique = models.filter(m => {
    const k = m.id.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return unique
}