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
