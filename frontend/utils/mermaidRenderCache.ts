import {
  recordCacheEviction,
  recordCacheHit,
  recordCacheMiss,
  recordCacheSize,
} from './cacheStats';
import { createLruCache } from './lruCache';

const DEFAULT_MAX_ENTRIES = 100;
/** Total SVG budget in UTF-16 code units (≈2 bytes per unit at most). The cap
 *  is TOTAL SIZE, not entry count: a single huge diagram must not be able to
 *  push every other diagram in the vault out of the cache. */
const DEFAULT_MAX_SVG_CHARS = 8 * 1024 * 1024;
/** Diagram ASTs are small, but a vault can hold many distinct sources. */
const PARSE_CACHE_LIMIT = 200;

export { DEFAULT_MAX_ENTRIES, DEFAULT_MAX_SVG_CHARS };

export interface MermaidRenderCacheOptions {
  /** Max cached diagrams. Default {@link DEFAULT_MAX_ENTRIES}. */
  maxEntries?: number;
  /** Max total SVG characters across cached diagrams. Default 8M. */
  maxSvgChars?: number;
  /** Measured size of one result; defaults to `result.svg.length`. */
  sizeOf?: (result: { svg: string }) => number;
}

function withId<T extends { svg: string }>(
  result: T,
  from: string,
  to: string,
): T {
  return from === to
    ? result
    : { ...result, svg: result.svg.replaceAll(from, to) };
}

export function whenIdle<T>(run: () => Promise<T>): Promise<T> {
  if (typeof requestIdleCallback === "undefined")
    return new Promise((resolve) => setTimeout(resolve, 0)).then(run);
  return new Promise<T>((resolve, reject) =>
    requestIdleCallback(() => void run().then(resolve, reject), {
      timeout: 250,
    }),
  );
}

interface RenderEntry<T> {
  pending: Promise<{ id: string; result: T }>;
  /** Bytes charged to the cache once the render resolves (0 while pending). */
  size: number;
}

export function cacheMermaidRender<T extends { svg: string }>(
  render: (id: string, source: string) => Promise<T>,
  options: MermaidRenderCacheOptions = {},
) {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxSvgChars = options.maxSvgChars ?? DEFAULT_MAX_SVG_CHARS;
  const sizeOf =
    options.sizeOf ?? ((result: { svg: string }) => result.svg.length);
  const cache = new Map<string, RenderEntry<T>>();
  let totalSize = 0;

  /** LRU eviction by COUNT and by TOTAL SVG size. The newest entry (last in Map
   *  order) is never evicted, so one diagram larger than the whole budget is
   *  still cached rather than re-rendered on every mount. */
  const report = () => recordCacheSize('mermaid-render', cache.size, totalSize);

  const evict = () => {
    while (cache.size > 1 && (cache.size > maxEntries || totalSize > maxSvgChars)) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const entry = cache.get(oldest);
      cache.delete(oldest);
      if (entry) totalSize -= entry.size;
      recordCacheEviction('mermaid-render');
    }
    report();
  };

  return async (id: string, source: string): Promise<T> => {
    const hit = cache.get(source);
    if (hit) {
      recordCacheHit('mermaid-render');
      cache.delete(source);
      cache.set(source, hit);
      const cached = await hit.pending;
      return withId(cached.result, cached.id, id);
    }
    recordCacheMiss('mermaid-render');
    const entry: RenderEntry<T> = { pending: undefined as never, size: 0 };
    entry.pending = render(id, source).then((result) => {
      // Charge the budget only if this entry is still cached — an entry evicted
      // while pending must not add size it no longer owns.
      if (cache.get(source) === entry) {
        entry.size = sizeOf(result);
        totalSize += entry.size;
        evict();
      }
      return { id, result };
    });
    cache.set(source, entry);
    entry.pending.catch(() => {
      // A failed render must not poison the cache: drop it so the next caller retries.
      if (cache.get(source) === entry) {
        cache.delete(source);
        totalSize -= entry.size;
        report();
      }
    });
    evict();
    const cached = await entry.pending;
    return withId(cached.result, cached.id, id);
  };
}

/** Mermaid appends a temporary `<div id="d{id}">` to `<body>` for every render and
 *  removes it only on SUCCESS: on a parse failure it rethrows before
 *  `removeTempElements` runs (`mermaid.core`: the cleanup call sits after the
 *  `throw`). The upstream hook never hit that path because it called `parse`
 *  first; the preview no longer does, so a failed render would leave an error
 *  diagram behind — one per keystroke on a diagram the user is still typing.
 *  A no-op when Mermaid cleaned up itself, or outside a DOM. */
function discardTempElement(id: string): void {
  if (typeof document === "undefined") return;
  document.getElementById(`d${id}`)?.remove();
}

/** Cache identical diagrams and serialize Mermaid's global renderer on an idle
 *  browser turn. A rejected render cannot poison the queue or cache. */
export function createQueuedMermaidRender<T extends { svg: string }>(
  render: (id: string, source: string) => Promise<T>,
  options: MermaidRenderCacheOptions = {},
) {
  let queue: Promise<unknown> = Promise.resolve();

  return cacheMermaidRender((id, source) => {
    const run = queue.then(() =>
      whenIdle(() =>
        render(id, source).catch((error: unknown) => {
          discardTempElement(id);
          console.error("[mermaid render]", id, error);
          throw error;
        }),
      ),
    );
    queue = run.catch(() => {});
    return run;
  }, options);
}

/** Memoize Mermaid's validator by source.
 *
 *  The export renderer (`renderToSizedSVG`, behind `renderDiagramToSVG` and
 *  `renderDiagramToImage`) validates with `parse` before rendering, and treats a
 *  throw as the typed "invalid diagram" result — so this is on the path of every
 *  export, and re-exporting a document re-validates every one of its diagrams
 *  without it. The editor preview no longer calls `parse` (see
 *  `CachedDiagramPreview`: `render` parses internally, and the finished SVG is
 *  cached ahead of that), so exports are the caller that matters here.
 *
 *  Failed parses are dropped, so a diagram the user just fixed re-validates — and
 *  a rejection still propagates, which is what the exporter's error path needs.
 *  Only the source is used as the key — every caller in this app passes a
 *  single argument. */
export function cacheMermaidParse<T>(
  parse: (source: string, ...rest: any[]) => Promise<T>,
) {
  const cache = new Map<string, Promise<T>>();
  const report = () => recordCacheSize('mermaid-parse', cache.size, 0);
  return async (source: string, ...rest: any[]): Promise<T> => {
    const hit = cache.get(source);
    if (hit) {
      recordCacheHit('mermaid-parse');
      return hit;
    }
    recordCacheMiss('mermaid-parse');
    const pending = parse(source, ...rest);
    cache.set(source, pending);
    pending.catch(() => {
      if (cache.get(source) === pending) cache.delete(source);
      report();
    });
    if (cache.size > PARSE_CACHE_LIMIT) {
      cache.delete(cache.keys().next().value as string);
      recordCacheEviction('mermaid-parse');
    }
    report();
    return pending;
  };
}

/** A finished, display-ready diagram: `trimDiagramSVG` applied and the label font
 *  already rewritten, i.e. exactly the string the preview injects. */
export interface DiagramSVGEntry {
  svg: string;
  /** Mermaid IDs are document-global; retain the render ID so each preview can
   *  remap it before inserting the shared SVG into the DOM. */
  renderId: string;
  /** The font family the SVG was rewritten to. A theme change invalidates the
   *  entry, since the font is baked into the markup and cannot be re-derived
   *  without redoing the rewrite. */
  fontFamily: string;
}

const DIAGRAM_SVG_MAX_ENTRIES = 60;
/** Separate budget from the render cache: a finished SVG is what the render cache
 *  holds again after trim + font, so charging both to one budget would halve the
 *  effective capacity for no benefit. */
const DIAGRAM_SVG_MAX_CHARS = 4 * 1024 * 1024;

/** Cache the LAST step of the diagram pipeline by source.
 *
 *  Reaching this step costs work no earlier cache can absorb: `trimDiagramSVG`
 *  appends to the document and forces a synchronous `getBBox` reflow, and
 *  `withSVGFontFamily` parses and re-serializes the SVG. A tab switch remounts
 *  the block (see `editorFactory`) but the diagram text is unchanged, so without
 *  this cache every switch pays that reflow again — and, because the block's
 *  state resets, shows an empty preview first (the visible "flash"). */
const diagramSVGs = createLruCache<DiagramSVGEntry>({
  name: 'diagram-svg',
  maxEntries: DIAGRAM_SVG_MAX_ENTRIES,
  maxChars: DIAGRAM_SVG_MAX_CHARS,
  sizeOf: (entry) => entry.svg.length,
});

/** Read a finished diagram. Pure and synchronous: safe during a React render. */
export function peekDiagramSVG(source: string): DiagramSVGEntry | null {
  return source ? diagramSVGs.peek(source) : null;
}

export function cacheDiagramSVG(
  source: string,
  svg: string,
  fontFamily: string,
  renderId = '',
): void {
  if (!source || !svg) return;
  diagramSVGs.set(source, { svg, fontFamily, renderId });
}

/** Drop every finished diagram, e.g. when the vault scope ends. */
export function clearDiagramSVG(): void {
  diagramSVGs.clear();
}
