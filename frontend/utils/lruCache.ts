import {
  recordCacheEviction,
  recordCacheHit,
  recordCacheMiss,
  recordCacheSize,
  type CacheName,
} from './cacheStats';

/** Least-recently-used cache bounded by BOTH entry count and total size.
 *
 *  `sizeOf` charges every value against one shared budget, so a single huge
 *  value cannot push everything else out. The newest entry always survives,
 *  even when it alone exceeds the budget: dropping it would mean recomputing it
 *  on the very next lookup, which is exactly the cost the cache exists to avoid.
 *
 *  This is the synchronous sibling of the Mermaid render cache, which cannot use
 *  it because its entries are in-flight promises that have no size until they
 *  resolve. Used by the caches that hold finished render output — diagram SVG and
 *  KaTeX HTML. */
export interface LruCacheOptions<T> {
  /** Cache identity for {@link readCacheStats} observability. */
  name: CacheName;
  maxEntries: number;
  /** Total `sizeOf` budget across all entries. */
  maxChars: number;
  sizeOf: (value: T) => number;
}

export interface LruCache<T> {
  /** Read, recording a hit or miss. Never creates an entry, never refreshes
   *  recency — safe to call during a React render. */
  peek(key: string): T | null;
  set(key: string, value: T): void;
  delete(key: string): void;
  clear(): void;
}

export function createLruCache<T>({
  name,
  maxEntries,
  maxChars,
  sizeOf,
}: LruCacheOptions<T>): LruCache<T> {
  const entries = new Map<string, { value: T; size: number }>();
  let chars = 0;

  const report = () => recordCacheSize(name, entries.size, chars);

  const evict = () => {
    while (entries.size > 1 && (entries.size > maxEntries || chars > maxChars)) {
      const oldest = entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const entry = entries.get(oldest);
      entries.delete(oldest);
      if (entry) chars -= entry.size;
      recordCacheEviction(name);
    }
  };

  return {
    peek(key) {
      const entry = entries.get(key);
      if (!entry) {
        recordCacheMiss(name);
        return null;
      }
      recordCacheHit(name);
      return entry.value;
    },

    set(key, value) {
      const existing = entries.get(key);
      if (existing) {
        entries.delete(key);
        chars -= existing.size;
      }
      const size = sizeOf(value);
      entries.set(key, { value, size });
      chars += size;
      evict();
      report();
    },

    delete(key) {
      const entry = entries.get(key);
      if (!entry) return;
      entries.delete(key);
      chars -= entry.size;
      report();
    },

    clear() {
      entries.clear();
      chars = 0;
      report();
    },
  };
}
