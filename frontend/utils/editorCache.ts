import { KeepAliveCache } from './keepAliveCache'

let cache: KeepAliveCache<unknown> | null = null
let cacheVaultPath: string | null = null

/** Get the shared cache without importing any editor dependency. */
export function getEditorCache<T>(vaultPath: string, create: (path: string) => T): KeepAliveCache<T> {
  if (!cache || cacheVaultPath !== vaultPath) {
    cache?.clear()
    cache = new KeepAliveCache(create)
    cacheVaultPath = vaultPath
  }
  return cache as KeepAliveCache<T>
}

/** Clear cached BlockNote instances when their vault scope ends. */
export function clearEditorCache() {
  cache?.clear()
  cache = null
  cacheVaultPath = null
}

/** Cache hit for a vault+path WITHOUT creating anything — a pure read, so a
 *  component may call it while rendering to decide between "show cached editor"
 *  and "create one". Returns null when the vault scope differs from the cached
 *  one (the caller's create path then resets the scope). */
export function peekEditorCache<T>(vaultPath: string, path: string): T | null {
  if (!cache || cacheVaultPath !== vaultPath) return null
  return cache.peek(path) as T | null
}
