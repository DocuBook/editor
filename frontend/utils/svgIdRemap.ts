/** Mermaid namespaces its DOM ids with the render id it was given (`<svg
 *  id="mermaid-render-7">`, `url(#mermaid-render-7-arrow)`, …). Our caches store
 *  the SVG under that id and each preview re-points it at its own id before
 *  inserting, so two blocks sharing one cached source do not collide.
 *
 *  Mermaid's own render ids end in a counter, so one id is a prefix of another
 *  (`mermaid-render-1` of `mermaid-render-10`). A `String.prototype.replaceAll`
 *  rewrites the longer id too and corrupts the SVG (a dangling `url(#…)`
 *  reference is exactly the broken-artifact class this guard is about). Only
 *  block the one character that makes the match a different render id — a
 *  digit — and leave genuine namespaced references (`-arrow`, `-flowchart-…`)
 *  remappable, since shadowing them would orphan their `url(#…)` references. */
export function remapSvgIds(svg: string, from: string, to: string): string {
  if (!from || from === to) return svg;
  return svg.replace(new RegExp(`${escapeRegExp(from)}(?!\\d)`, "g"), to);
}

/** Minimal literal escape. `RegExp.escape` cannot be used: it is a Safari
 *  16.4+ feature while vite.config.ts targets Safari 15, and esbuild leaves the
 *  call as-is rather than refusing to transpile it (verified by building
 *  `RegExp.escape("a-b")` for `--target=safari15`), so it would ship a runtime
 *  `TypeError` to the very browsers this guard exists for. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
