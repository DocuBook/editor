import { recordCacheHit, recordCacheMiss, recordCacheSize, type CacheName } from './cacheStats'

/** Generic lazy cache used by the editor keep-alive boundary.
 *
 *  Deliberately NOT size-bounded: an evicted entry is a whole BlockNote instance,
 *  and dropping one on a tab switch would rebuild the editor and lose its undo
 *  history. It IS observable instead — hits, misses and entry count land in
 *  `__docubookCacheStats().'editor-instances'`, which is what makes "how many
 *  editors are we holding?" answerable without guessing. */
export class KeepAliveCache<T> {
  private entries = new Map<string, T>()
  private readonly create: (key: string) => T
  private readonly name: CacheName

  constructor(create: (key: string) => T, name: CacheName = 'editor-instances') {
    this.create = create
    this.name = name
  }

  get(key: string): T {
    if (!this.entries.has(key)) {
      recordCacheMiss(this.name)
      this.entries.set(key, this.create(key))
      this.report()
      return this.entries.get(key)!
    }
    recordCacheHit(this.name)
    return this.entries.get(key)!
  }

  /** Existing entry only — never creates one. Safe to call during render.
   *  Unrecorded on purpose: a peek is a read, not a cache decision. */
  peek(key: string): T | null {
    return this.entries.has(key) ? this.entries.get(key)! : null
  }

  clear() {
    this.entries.clear()
    this.report()
  }

  /** Editor instances carry no byte size, so only the entry count is reported. */
  private report() {
    recordCacheSize(this.name, this.entries.size, 0)
  }
}
