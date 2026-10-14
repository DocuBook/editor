import { useEffect, useState } from 'react'
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
import { SiMermaid } from 'react-icons/si'
import { cacheDiagramSVG, peekDiagramSVG } from '../../utils/mermaidRenderCache'

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

const svgForPreview = (source: string, previewId: string): string => {
  const cached = peekDiagramSVG(source)
  return cached?.svg && cached.renderId
    ? cached.svg.replaceAll(cached.renderId, previewId)
    : cached?.svg ?? ''
}

const seed = (source: string, previewId: string): StoredDiagram => ({
  source,
  svg: svgForPreview(source, previewId),
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
 *  work and that flash. Keep in sync with the upstream hook. */
function useCachedMermaidSVG(source: string, fontFamilyElement?: Element): DiagramRenderState {
  const [previewId] = useState(() => `mermaid-preview-${diagramElementId++}`)
  const [stored, setStored] = useState<StoredDiagram>(() => seed(source, previewId))

  useEffect(() => {
    // Nothing to fetch while the source is empty; the render below already shows
    // an empty preview, so resetting state here would only cascade a render.
    if (!source.trim()) return

    initializeMermaid()

    // Read the font at render time, not at mount — the computed font is themable
    // via CSS, so a memoized read would go stale on a theme change.
    const fontFamily = fontFamilyElement
      ? getComputedStyle(fontFamilyElement).fontFamily
      : ''

    // Already painted from the cache by the render below; re-rendering would
    // redo `trimDiagramSVG` for an SVG that is byte-identical.
    const cached = peekDiagramSVG(source)
    if (cached && cached.fontFamily === fontFamily) return

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
        const svg = fontFamily ? withSVGFontFamily(trimmed, fontFamily) : trimmed
        cacheDiagramSVG(source, svg, fontFamily, renderId)
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
  }, [source, fontFamilyElement, previewId])

  // Derived during render, never set from the effect: an empty source, and the
  // last-good carry-over while a changed source renders, both fall out of the
  // current source instead of a `setState` that would schedule another render.
  if (!source.trim()) return { svg: '' }
  if (stored.source === source) return { svg: stored.svg, error: stored.error }
  const cachedSvg = svgForPreview(source, previewId)
  if (cachedSvg) return { svg: cachedSvg }
  return { svg: stored.svg, error: stored.error }
}

export const CachedDiagramPreviewWithPopup = (
  props: ReactCustomBlockRenderProps<DiagramBlockConfig>,
) => {
  const source = plainContentToString(props.block.content).trim()
  const { svg, error } = useCachedMermaidSVG(source, props.editor.domElement)
  const dict = getDiagramDictionary(props.editor).block

  return (
    <SourceBlockWithPreview
      block={props.block}
      editor={props.editor}
      contentRef={props.contentRef}
      source={source}
      // `undefined` while nothing has rendered successfully, so an error shows the
      // error state instead of an empty preview.
      preview={
        svg ? (
          <div
            // Centers the diagram — Mermaid's SVG is left-aligned otherwise.
            style={{ display: 'flex', justifyContent: 'center' }}
            role="img"
            aria-label={dict.preview_label}
            dangerouslySetInnerHTML={{ __html: svg }}
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
