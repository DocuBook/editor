/** BlockNote schema (heading 1-5 + math/diagram blocks) and the [[wikilink]]
 *  ProseMirror decoration/click handling — shared, single-instance setup. */
import { createElement, useSyncExternalStore } from 'react'
import { createHeadingBlockSpec, BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs, createExtension } from '@blocknote/core'
import { createReactBlockSpec } from '@blocknote/react'
import { createReactMathBlockSpec, createReactInlineMathSpec } from '@blocknote/math-block'
import { createDiagramBlockConfig, DiagramBlockPreviewWithPopup, parseDiagramCodeContent, parseDiagramCodeElement } from '@blocknote/diagram-block'
import { Plugin } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { findWikilinkAt, openWikilink } from '../../utils/wikilink'

let _diagramRenderingPaused = false
const _diagramRenderingListeners = new Set<() => void>()

export const setDiagramRenderingPaused = (paused: boolean) => {
  if (_diagramRenderingPaused === paused) return
  _diagramRenderingPaused = paused
  _diagramRenderingListeners.forEach((listener) => listener())
}

const diagramSpec = createReactBlockSpec(createDiagramBlockConfig, {
  meta: { code: true, defining: true, isolating: false, highlight: () => 'mermaid', hasPreview: true, hardBreakShortcut: 'enter' },
  parse: parseDiagramCodeElement,
  parseContent: parseDiagramCodeContent,
  runsBefore: ['codeBlock'],
  render: function DiagramRender(props) {
    const paused = useSyncExternalStore(
      (listener) => { _diagramRenderingListeners.add(listener); return () => _diagramRenderingListeners.delete(listener) },
      () => _diagramRenderingPaused,
    )
    return paused
      ? createElement('pre', null, createElement('code', { className: 'language-mermaid', 'data-language': 'mermaid', ref: props.contentRef }))
      : createElement(DiagramBlockPreviewWithPopup, props)
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
      mathBlock: createReactMathBlockSpec(),
      diagram: diagramSpec(),
    },
    inlineContentSpecs: {
      ...defaultInlineContentSpecs,
      math: createReactInlineMathSpec(),
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
