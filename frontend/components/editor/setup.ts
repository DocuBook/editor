/** BlockNote schema (heading 1-5 + math/diagram blocks) and the [[wikilink]]
 *  ProseMirror decoration/click handling — shared, single-instance setup. */
import { createHeadingBlockSpec, BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs, createExtension } from '@blocknote/core'
import { createReactMathBlockSpec, createReactInlineMathSpec } from '@blocknote/math-block'
import { createReactDiagramBlockSpec } from '@blocknote/diagram-block'
import { Plugin } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { findWikilinkAt, openWikilink } from '../../utils/wikilink'

/** Base BlockNote schema with heading levels 1-5. */
let _schema: any = null
export const getSchema = () => {
  if (!_schema) _schema = BlockNoteSchema.create({
    blockSpecs: {
      ...defaultBlockSpecs,
      heading: createHeadingBlockSpec({ levels: [1, 2, 3, 4, 5], allowToggleHeadings: false }),
      mathBlock: createReactMathBlockSpec(),
      diagram: createReactDiagramBlockSpec(),
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
 *  stored content stays literal `[[Title]]` (markdown round-trip untouched). */
export const wikilinkStyler = createExtension({
  key: 'wikilinkStyler',
  prosemirrorPlugins: [
    new Plugin({
      props: {
        decorations(state) {
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
