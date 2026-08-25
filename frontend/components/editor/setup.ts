/** BlockNote schema (heading 1-5 + math/diagram blocks) and the [[wikilink]]
 *  ProseMirror decoration/click handling — shared, single-instance setup. */
import { createElement, useRef, useSyncExternalStore } from 'react'
import { createHeadingBlockSpec, BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs, createExtension } from '@blocknote/core'
import { createReactBlockSpec, createReactInlineContentSpec } from '@blocknote/react'
import {
  BlockMathMLElement,
  MathBlockInputRulesExtension,
  MathBlockPreviewWithPopup,
  MathInlineInputRulesExtension,
  MathInlinePreviewWithPopup,
  createMathBlockConfig,
  InlineMathMLElement,
  mathInlineContentConfig,
  parseBlockMathMLContent,
  parseBlockMathMLElement,
  parseInlineMathMLContent,
  parseInlineMathMLElement,
} from '@blocknote/math-block'
import { createDiagramBlockConfig, DiagramBlockPreviewWithPopup, parseDiagramCodeContent, parseDiagramCodeElement } from '@blocknote/diagram-block'
import { Plugin } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { findWikilinkAt, openWikilink } from '../../utils/wikilink'

let _previewRenderingPaused = false
const _previewRenderingListeners = new Set<() => void>()

export const setPreviewRenderingPaused = (paused: boolean) => {
  if (_previewRenderingPaused === paused) return
  _previewRenderingPaused = paused
  _previewRenderingListeners.forEach((listener) => listener())
}

const usePreviewRenderingPaused = () => useSyncExternalStore(
  (listener) => { _previewRenderingListeners.add(listener); return () => _previewRenderingListeners.delete(listener) },
  () => _previewRenderingPaused,
)

/** Keep existing source previews mounted while AI updates their source. New
 * previews use source view until rendering is enabled. */
function StableSourcePreview({ paused, props, language, Preview, fallback }: { paused: boolean; props: any; language: string; Preview: any; fallback: 'block' | 'inline' }) {
  const stableProps = useRef<any | null>(null)
  const stableElement = useRef<any | null>(null)
  const latestContentRef = useRef(props.contentRef)
  const stableContentRef = useRef<((node: HTMLElement | null) => void) | null>(null)
  const latestNode = useRef(props.node)
  const latestGetPos = useRef(props.getPos)
  const stableNode = useRef<any | null>(null)
  const stableGetPos = useRef<(() => number | undefined) | null>(null)

  latestContentRef.current = props.contentRef
  latestNode.current = props.node
  latestGetPos.current = props.getPos
  if (!stableContentRef.current) stableContentRef.current = (node) => latestContentRef.current(node)
  // Keep inline popup position live without passing changing props into frozen preview.
  if (fallback === 'inline' && !stableNode.current) stableNode.current = { get nodeSize() { return latestNode.current.nodeSize } }
  if (fallback === 'inline' && !stableGetPos.current) stableGetPos.current = () => latestGetPos.current()

  if (!paused) {
    stableProps.current = props
    stableElement.current = null
  }

  if (paused && !stableElement.current) {
    if (!stableProps.current) {
      const code = createElement('code', {
        className: `language-${language}`,
        'data-language': language,
        ref: stableContentRef.current,
      })
      stableElement.current = fallback === 'inline' ? code : createElement('pre', null, code)
    } else {
      const previewProps = {
        ...stableProps.current,
        contentRef: stableContentRef.current,
        ...(fallback === 'inline' ? { node: stableNode.current, getPos: stableGetPos.current } : {}),
      }
      stableElement.current = createElement(Preview, previewProps)
    }
  }

  return paused ? stableElement.current : createElement(Preview, props)
}

function StableDiagramPreview({ paused, props }: { paused: boolean; props: any }) {
  return createElement(StableSourcePreview, { paused, props, language: 'mermaid', Preview: DiagramBlockPreviewWithPopup, fallback: 'block' })
}

function StableMathBlockPreview({ paused, props }: { paused: boolean; props: any }) {
  return createElement(StableSourcePreview, { paused, props, language: 'latex', Preview: MathBlockPreviewWithPopup, fallback: 'block' })
}

function StableMathInlinePreview({ paused, props }: { paused: boolean; props: any }) {
  return createElement(StableSourcePreview, { paused, props, language: 'latex', Preview: MathInlinePreviewWithPopup, fallback: 'inline' })
}

const mathBlockSpec = createReactBlockSpec(createMathBlockConfig, {
  meta: { code: true, defining: true, isolating: false, highlight: () => 'latex', hasPreview: true, hardBreakShortcut: 'shift+enter' },
  parse: parseBlockMathMLElement,
  parseContent: parseBlockMathMLContent,
  render: function MathBlockRender(props) {
    return createElement(StableMathBlockPreview, { paused: usePreviewRenderingPaused(), props })
  },
  toExternalHTML: BlockMathMLElement,
}, [MathBlockInputRulesExtension])

const mathInlineSpec = createReactInlineContentSpec(mathInlineContentConfig, {
  meta: { code: true, highlight: () => 'latex', hasPreview: true },
  parse: parseInlineMathMLElement,
  parseContent: parseInlineMathMLContent,
  render: function MathInlineRender(props) {
    return createElement(StableMathInlinePreview, { paused: usePreviewRenderingPaused(), props })
  },
  toExternalHTML: InlineMathMLElement,
}, [MathInlineInputRulesExtension])

const diagramSpec = createReactBlockSpec(createDiagramBlockConfig, {
  meta: { code: true, defining: true, isolating: false, highlight: () => 'mermaid', hasPreview: true, hardBreakShortcut: 'enter' },
  parse: parseDiagramCodeElement,
  parseContent: parseDiagramCodeContent,
  runsBefore: ['codeBlock'],
  render: function DiagramRender(props) {
    const paused = usePreviewRenderingPaused()
    return createElement(StableDiagramPreview, { paused, props })
  },
  toExternalHTML: (props) => createElement('pre', null, createElement('code', { className: 'language-mermaid', 'data-language': 'mermaid', ref: props.contentRef })),
})

/** Base BlockNote schema with heading levels 1-5. */
let _schema: any = null
export const getSchema = () => {
  if (!_schema) _schema = BlockNoteSchema.create({
    blockSpecs: {
      ...defaultBlockSpecs,
      heading: createHeadingBlockSpec({ levels: [1, 2, 3, 4, 5], allowToggleHeadings: false }),
      mathBlock: mathBlockSpec(),
      diagram: diagramSpec(),
    },
    inlineContentSpecs: {
      ...defaultInlineContentSpecs,
      math: mathInlineSpec,
    },
  })
  return _schema
}

/** Visual indicator for `[[wikilink]]` text: accent + underline + pointer so
 *  Cmd+Click navigation is discoverable. ProseMirror decorations only — the
 *  stored content stays literal `[[Title]]` (markdown round-trip untouched).
 *
 *  The full-doc regex scan runs on EVERY transaction — during AI typing that
 *  is one O(document) scan per 50ms batch. WysiwygEditor pauses it while the
 *  AI writes (setWikilinkStylerPaused); the underline returns on unpause via
 *  the empty-transaction nudge (decorations only recompute on state change). */
let _decosPaused = false
export const setWikilinkStylerPaused = (paused: boolean) => { _decosPaused = paused }
export const wikilinkStyler = createExtension({
  key: 'wikilinkStyler',
  prosemirrorPlugins: [
    new Plugin({
      props: {
        decorations(state) {
          if (_decosPaused) {
            // Skip the O(document) scan while streaming — no underline during
            // AI typing is a fine trade for not rescanning per 50ms batch.
            return DecorationSet.empty
          }
          const decos: Decoration[] = []
          const re = /\[\[([^\]]+)\]\]/g
          state.doc.descendants((node, pos) => {
            if (node.isText) {
              const text = node.text || ''
              let m: RegExpExecArray | null
              while ((m = re.exec(text)) !== null) {
                decos.push(Decoration.inline(pos + m.index, pos + m.index + m[0].length, {
                  'data-wikilink': '1',
                  style: 'color: var(--color-accent); text-decoration: underline; cursor: pointer;',
                }))
              }
            }
            return true
          })
          return DecorationSet.create(state.doc, decos)
        },
        /** Cmd/Ctrl+Click on a `[[wikilink]]` opens the note. Must run here
         *  (ProseMirror prop) and return true: PM core's `selectNodeModifier`
         *  (metaKey on mac) would otherwise select the whole paragraph block
         *  on mouseup — conflicting with navigation and crashing the editor
         *  when the document is swapped mid node-selection. */
        handleClick(view, pos, event) {
          if (!(event.metaKey || event.ctrlKey)) return false
          const t = event.target as HTMLElement | null
          if (!(t?.tagName === 'SPAN' && t.getAttribute('data-wikilink') === '1')) return false
          const $pos = view.state.doc.resolve(pos)
          const title = findWikilinkAt($pos.parent.textContent || '', pos - $pos.start())
          if (title) {
            openWikilink(title)
            return true // consumed — PM skips its own selection entirely
          }
          return false
        },
      },
    }),
  ],
})
