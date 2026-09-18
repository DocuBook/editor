import katex, { type KatexOptions } from 'katex';
import { createLruCache } from './lruCache';

const MAX_ENTRIES = 200;
/** KaTeX HTML for complex formulas runs to a few KB; this bounds a vault's worth. */
const MAX_CHARS = 4 * 1024 * 1024;

/** Memoize KaTeX output by (source, options).
 *
 *  `@blocknote/math-block` renders every formula with a plain
 *  `katex.renderToString` call — once per mount, and inline formulas mount again
 *  on every document view that contains them. The function is pure: same input,
 *  same markup, byte for byte, which makes it safe to share across mounts. The
 *  key includes the options because `displayMode` changes the output and the
 *  error path re-renders with `throwOnError: false`. */
const cache = createLruCache<string>({
  name: 'katex-render',
  maxEntries: MAX_ENTRIES,
  maxChars: MAX_CHARS,
  sizeOf: (html) => html.length,
});

/** Wrap `renderToString` with the memo. Failures are NOT cached, so a formula the
 *  user is mid-way through typing re-renders as it changes. */
export function cachedRenderToString(
  renderToString: (tex: string, options?: KatexOptions) => string,
): (tex: string, options?: KatexOptions) => string {
  return (tex, options) => {
    const key = options ? `${tex}\u0000${JSON.stringify(options)}` : tex;
    const hit = cache.peek(key);
    if (hit !== null) return hit;
    const html = renderToString(tex, options);
    cache.set(key, html);
    return html;
  };
}

/** Patch the KaTeX singleton in place.
 *
 *  `@blocknote/math-block` imports the same `katex` module, so replacing the
 *  method here covers the preview and every inline formula without touching the
 *  block implementation. The `ParseError` class is left alone — the caller's
 *  `instanceof` check still works because the wrapper rethrows untouched. */
export function installKatexRenderCache(): void {
  katex.renderToString = cachedRenderToString(katex.renderToString);
}

export { cache as katexRenderCache };
