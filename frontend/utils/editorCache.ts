import { KeepAliveCache } from './keepAliveCache'

let cache: KeepAliveCache<unknown> | null = null
let cacheVaultPath: string | null = null

type CachedEditor = {
  editor?: {
    getExtension?: (name: 'ai') => { abort?: (reason?: string) => unknown } | undefined
  }
}

function abortAi(cached: unknown, reason: string) {
  const extension = (cached as CachedEditor | null)?.editor?.getExtension?.('ai')
  try {
    void Promise.resolve(extension?.abort?.(reason)).catch(error => console.error('Failed to abort AI stream', error))
  } catch (error) {
    console.error('Failed to abort AI stream', error)
  }
}

/** Get the shared cache without importing any editor dependency. */
export function getEditorCache<T>(vaultPath: string, create: (path: string) => T): KeepAliveCache<T> {
  if (!cache || cacheVaultPath !== vaultPath) {
    clearEditorCache()
    cache = new KeepAliveCache(create)
    cacheVaultPath = vaultPath
  }
  return cache as KeepAliveCache<T>
}

/** Clear cached BlockNote instances when their vault scope ends. */
export function clearEditorCache() {
  cache?.forEach(editor => abortAi(editor, 'vault closed'))
  cache?.clear()
  cache = null
  cacheVaultPath = null
}

/** Stop and release one page's cached editor when its owning tab is closed, or
 *  when its file moves (`reason`): the instance's AI stream and snapshot writes
 *  are bound to the path it was created for, so after a rename it would keep
 *  writing to a path that no longer exists. */
export function closeCachedEditor(path: string, reason = 'tab closed') {
  const editor = cache?.peek(path)
  if (!editor) return
  abortAi(editor, reason)
  cache?.delete(path)
}

/** Cache hit for a vault+path WITHOUT creating anything — a pure read, so a
 *  component may call it while rendering to decide between "show cached editor"
 *  and "create one". Returns null when the vault scope differs from the cached
 *  one (the caller's create path then resets the scope). */
export function peekEditorCache<T>(vaultPath: string, path: string): T | null {
  if (!cache || cacheVaultPath !== vaultPath) return null
  return cache.peek(path) as T | null
}
