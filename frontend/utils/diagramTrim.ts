import { trimDiagramSVG } from '@blocknote/diagram-block'

/** `trimDiagramSVG` with a guard against a degenerate `getBBox()` measurement.
 *
 *  The upstream helper measures the SVG in a `visibility:hidden` probe on
 *  `<body>` and shrinks the `viewBox` height to `bbox.y + bbox.height - viewBox.y
 *  + 8`. Engines disagree about `getBBox()` in a hidden subtree: where WebKit
 *  returns a zero/partial box the height collapses toward the 8px padding and
 *  the diagram renders crushed ("svg rusak").
 *
 *  The measurement is a pure optimisation — trimming only ever shrinks the
 *  viewBox to the drawn extent. When it is not trustworthy we drop it and keep
 *  the SVG exactly as Mermaid produced it: an untrimmed diagram with the correct
 *  geometry beats a trimmed one that is squashed.
 *
 *  `MIN_TRIMMED_HEIGHT` is the acceptance floor, and it is deliberately below
 *  anything a real diagram produces: the height keeps its Mermaid padding, so
 *  even a genuinely near-empty diagram is taller than this. It only rejects the
 *  collapse signature (a height driven to the padding instead of to `getBBox`).
 *  The limitation is honest: a partial measurement that still lands above the
 *  floor is accepted, so this cannot prove a trim correct — it rejects the
 *  degenerate case, no more.
 *
 *  The guard only judges the HEIGHT shrink. The upstream trim also drops a
 *  fixed `height` attribute, and an SVG without a `viewBox` can still need that
 *  — so the trim is delegated unconditionally and the guard restores the source
 *  only on its specific, height-collapse signature. */
const MIN_TRIMMED_HEIGHT = 8

export function safeTrimDiagramSVG(svg: string): string {
  const before = viewBoxHeight(svg)
  const trimmed = trimDiagramSVG(svg)
  const after = viewBoxHeight(trimmed)
  if (before === null || after === null) return trimmed
  return after >= MIN_TRIMMED_HEIGHT && after < before ? trimmed : svg
}

/** Height component of an `<svg>`'s `viewBox`, or null when absent/malformed. */
function viewBoxHeight(svg: string): number | null {
  const match = svg.match(/viewBox=["']([^"']+)["']/)
  if (!match) return null
  const parts = match[1].trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  return parts[3]
}
