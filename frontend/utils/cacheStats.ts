/** Shared observability for the render caches.
 *
 *  Every cache that can absorb a tab switch — BlockNote instances, Mermaid
 *  renders and parses, finished diagram SVGs, KaTeX output — records hits,
 *  misses, evictions and current size here, so "is the cache actually working,
 *  and how much memory is it holding?" is answerable from the devtools console:
 *
 *    __docubookCacheStats()
 *
 *  Recording a counter is O(1) and allocation-free, so instrumenting a render
 *  path costs nothing measurable. Kept deliberately dependency-free: the caches
 *  themselves (including `keepAliveCache`) stay unaware of who reads the stats. */

export type CacheName =
  | 'editor-instances'
  | 'mermaid-render'
  | 'mermaid-parse'
  | 'diagram-svg'
  | 'katex-render';

export interface CacheStat {
  /** Lookups served without doing the work. */
  hits: number;
  /** Lookups that had to compute a result. */
  misses: number;
  /** Entries dropped to stay within the entry/character budget. */
  evictions: number;
  /** Entries currently held. */
  entries: number;
  /** Total `sizeOf` of the held entries (UTF-16 units for SVG/HTML caches). */
  chars: number;
}

export type CacheStats = Record<CacheName, CacheStat>;

const names: CacheName[] = [
  'editor-instances',
  'mermaid-render',
  'mermaid-parse',
  'diagram-svg',
  'katex-render',
];

const stats = new Map<CacheName, CacheStat>();

function statFor(name: CacheName): CacheStat {
  let stat = stats.get(name);
  if (!stat) {
    stat = { hits: 0, misses: 0, evictions: 0, entries: 0, chars: 0 };
    stats.set(name, stat);
  }
  return stat;
}

export function recordCacheHit(name: CacheName): void {
  statFor(name).hits += 1;
}

export function recordCacheMiss(name: CacheName): void {
  statFor(name).misses += 1;
}

export function recordCacheEviction(name: CacheName): void {
  statFor(name).evictions += 1;
}

export function recordCacheSize(name: CacheName, entries: number, chars: number): void {
  const stat = statFor(name);
  stat.entries = entries;
  stat.chars = chars;
}

/** Snapshot of every counter. Fresh objects, so callers can't mutate the store. */
export function readCacheStats(): CacheStats {
  return Object.fromEntries(
    names.map((name) => [name, { ...statFor(name) }]),
  ) as CacheStats;
}

/** Drop every counter. For tests only — a running app never needs this. */
export function resetCacheStats(): void {
  stats.clear();
}

declare global {
  interface Window {
    /** Console entry point for {@link readCacheStats}. */
    __docubookCacheStats?: () => CacheStats;
  }
}

if (typeof window !== 'undefined') window.__docubookCacheStats = readCacheStats;
