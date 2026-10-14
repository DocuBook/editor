/**
 * Runtime model discovery — replaces the generated provider catalog's model
 * lists. The backend `list_models` command calls `GET {baseUrl}/models` with
 * the stored key (frontend never holds keys, SEC-5), SSRF-guarded + no
 * redirects. Cached per provider+baseUrl for 5 minutes.
 */
import { invoke } from '../lib/ipc'

export interface DiscoveredModel {
  id: string
  name: string
}

const TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { at: number; models: DiscoveredModel[] }>()

/** `apiKey` is optional: the composer discovers with the STORED key, while the
 *  settings form may pass a key the user just typed but has not saved yet — the
 *  one case where discovery must run before the backend knows the key. */
export async function fetchProviderModels(provider: string, baseUrl: string, apiKey?: string): Promise<DiscoveredModel[]> {
  const key = provider + '|' + baseUrl
  const hit = cache.get(key)
  /** A cache hit is only reusable for a stored-key lookup: an explicit key is a
   *  different (unsaved) credential, so it must not read the cached list. */
  if (!apiKey && hit && Date.now() - hit.at < TTL_MS) return hit.models
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
  cache.set(key, { at: Date.now(), models: unique })
  return unique
}