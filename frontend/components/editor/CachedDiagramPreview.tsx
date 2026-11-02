import { useEffect, useMemo, useState } from 'react'
import { plainContentToString } from '@blocknote/core'
import {
  PreviewPlaceholder,
  SourceBlockWithPreview,
  type ReactCustomBlockRenderProps,
} from '@blocknote/react'
import mermaid from 'mermaid'
import {
  getDiagramDictionary,
  initializeMermaid,
  trimDiagramSVG,
  withSVGFontFamily,
  type DiagramBlockConfig,
} from '@blocknote/diagram-block'
import { Skeleton } from '@mantine/core'
import { SiMermaid } from 'react-icons/si'
import { cacheDiagramSVG, peekDiagramSVG } from '../../utils/mermaidRenderCache'
import { readDiagramStyle } from '../../utils/mermaidTheme'
import { useTheme } from '../../stores/theme'

/** Space held for a diagram whose first render is pending — about a small
 *  flowchart's height, so most diagrams grow from it rather than jump. */
const DIAGRAM_SKELETON_HEIGHT = 160

/** Each render needs its own element ID: Mermaid removes any existing document
 *  element with the given ID when rendering, which would yank a displayed diagram
 *  out from under the view. (Mirrors the upstream hook.) */
let diagramElementId = 0

interface DiagramRenderState {
  svg: string
  error?: string
}

/** A render result tagged with the source it belongs to, so a stale result (or a
 *  stale last-good diagram) can be told apart from the current one during render. */
interface StoredDiagram extends DiagramRenderState {
  source: string
}

/** The cached diagram for `source`, but only one rendered under the current
 *  style: an entry from before a theme switch carries the old palette. */
const svgForPreview = (source: string, previewId: string, styleKey: string): string => {
  const cached = peekDiagramSVG(source)
  if (cached?.styleKey !== styleKey) return ''
  return cached.svg && cached.renderId
    ? cached.svg.replaceAll(cached.renderId, previewId)
    : cached.svg
}

const seed = (source: string, previewId: string, styleKey: string): StoredDiagram => ({
  source,
  svg: svgForPreview(source, previewId, styleKey),
})

/** Mermaid's preview pipeline, with the finished SVG cached by source.
 *
 *  Adapted from `useMermaidSVG` in `@blocknote/diagram-block` — same steps, same
 *  "keep the last good diagram up while editing" behaviour. It is reimplemented
 *  rather than reused because the cache must wrap the two steps that run AFTER
 *  `mermaid.render`, and the upstream hook exposes no seam for them: its state
 *  starts empty on every mount, so a remount both re-runs `trimDiagramSVG` (a
 *  synchronous `getBBox` reflow) and the font rewrite, AND shows a blank preview
 *  first — the flash a diagram-heavy document makes on every tab switch.
 *
 *  A tab switch remounts the block (see `editorFactory`: the BlockNote instance
 *  survives, the view does not), so the seeded initial state is what removes that
 *  work and that flash. Keep in sync with the upstream hook.
 *
 *  Unlike upstream, it also re-renders on a theme switch: Mermaid bakes the
 *  palette into the SVG (see `mermaidTheme`), so a cached entry is only served
 *  while its style key still matches. Settings replaces the editor, so a switch
 *  usually lands while the block is unmounted, and the next mount must not
 *  paint the old palette from the cache. */
function useCachedMermaidSVG(
  source: string,
  theme: string,
  fontFamilyElement?: Element,
): DiagramRenderState {
  const [previewId] = useState(() => `mermaid-preview-${diagramElementId++}`)
  // Re-read on every theme switch, not once per mount: the font and the palette
  // are both themable via CSS, so a read kept across a switch would be stale.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `theme` is the trigger; the values come from CSS
  const style = useMemo(() => readDiagramStyle(fontFamilyElement), [theme, fontFamilyElement])
  const [stored, setStored] = useState<StoredDiagram>(() => seed(source, previewId, style.key))

  useEffect(() => {
    // Nothing to fetch while the source is empty; the render below already shows
    // an empty preview, so resetting state here would only cascade a render.
    if (!source.trim()) return

    initializeMermaid()

    // Already painted from the cache by the render below; re-rendering would
    // redo `trimDiagramSVG` for an SVG that is byte-identical.
    const cached = peekDiagramSVG(source)
    if (cached && cached.styleKey === style.key) return

    // Rendering is asynchronous, so bail out if the source changed (or the block
    // was removed) before it finished. `source` is captured here, so the cache
    // write can only ever record the SVG it actually rendered.
    let stale = false
    void (async () => {
      const renderId = `mermaid-render-${diagramElementId++}`
      try {
        // No separate `mermaid.parse`: `render` parses internally, so an invalid
        // source throws the same parser error here as it would there. Keep this ID
        // distinct from the visible preview: Mermaid removes existing DOM IDs on
        // render, and the visible SVG must survive while a new source is rendering.
        const { svg: rendered } = await mermaid.render(renderId, source)
        if (stale) return
        const trimmed = trimDiagramSVG(rendered)
        const svg = style.fontFamily ? withSVGFontFamily(trimmed, style.fontFamily) : trimmed
        cacheDiagramSVG(source, svg, style.key, renderId)
        setStored({ source, svg: svg.replaceAll(renderId, previewId) })
      } catch (err) {
        if (stale) return
        // The last good diagram stays up, like the upstream hook: only the error
        // state changes.
        setStored((prev) => ({
          source,
          svg: prev.svg,
          error: err instanceof Error ? err.message : String(err),
        }))
      }
    })()

    return () => {
      stale = true
    }
  }, [source, style, previewId])

  // Derived during render, never set from the effect: an empty source, and the
  // last-good carry-over while a changed source renders, both fall out of the
  // current source instead of a `setState` that would schedule another render.
  if (!source.trim()) return { svg: '' }
  if (stored.source === source) return { svg: stored.svg, error: stored.error }
  const cachedSvg = svgForPreview(source, previewId, style.key)
  if (cachedSvg) return { svg: cachedSvg }
  return { svg: stored.svg, error: stored.error }
}

export const CachedDiagramPreviewWithPopup = (
  props: ReactCustomBlockRenderProps<DiagramBlockConfig>,
) => {
  const source = plainContentToString(props.block.content).trim()
  const theme = useTheme((s) => s.name)
  const { svg, error } = useCachedMermaidSVG(source, theme, props.editor.domElement)
  const dict = getDiagramDictionary(props.editor).block

  return (
    <SourceBlockWithPreview
      block={props.block}
      editor={props.editor}
      contentRef={props.contentRef}
      source={source}
      // A skeleton while the first render of this source is still in flight
      // (nothing cached, nothing rendered yet), so the block holds space instead
      // of collapsing to an empty strip until Mermaid resolves. `undefined` once
      // that render failed, so the error state shows instead of a skeleton that
      // would never resolve.
      preview={
        svg ? (
          <div
            // Centers the diagram — Mermaid's SVG is left-aligned otherwise.
            style={{ display: 'flex', justifyContent: 'center' }}
            role="img"
            aria-label={dict.preview_label}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : error == null ? (
          <Skeleton
            className="diagram-preview-skeleton"
            height={DIAGRAM_SKELETON_HEIGHT}
            radius="sm"
            role="img"
            aria-busy="true"
            aria-label={dict.preview_label}
          />
        ) : undefined
      }
      error={error}
      errorPreview={
        <PreviewPlaceholder
          error
          icon={<SiMermaid />}
          text={dict.preview_error_text}
        />
      }
      emptySourcePlaceholder={
        <PreviewPlaceholder icon={<SiMermaid />} text={dict.add_source_text} />
      }
      sourcePlaceholder={dict.input_placeholder}
    />
  )
}
