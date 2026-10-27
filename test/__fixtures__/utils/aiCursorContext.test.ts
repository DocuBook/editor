// @vitest-environment jsdom
/**
 * Cursor-mode context for the text path (Path B), on a real BlockNote editor.
 * The document used to be cut into flattened before/anchor/after slices and
 * rendered slice by slice, but a parent's Markdown already holds its children:
 * every nested block came out twice, a caret in a nested item put the marker
 * after a stray top-level copy of it, and a list cut at the caret restarted
 * its numbering.
 */
import { BlockNoteEditor } from '@blocknote/core'
import { TextSelection } from 'prosemirror-state'
import { afterEach, describe, expect, it } from 'vitest'
import { getSchema } from '../../../frontend/components/editor/setup'
import { buildDocumentContext, CURSOR_MARKER } from '../../../frontend/utils/aiBlocks'

let editor: any

afterEach(() => {
  editor = undefined
})

function create(content: any[]) {
  editor = BlockNoteEditor.create({ schema: getSchema() as any, initialContent: content })
  return editor
}

/** Put the caret `offset` characters into block `id`. */
function caret(ed: any, id: string, offset = 0) {
  let at = -1
  ed.prosemirrorState.doc.descendants((node: any, pos: number) => {
    if (at < 0 && node.attrs?.id === id) at = pos + 2 + offset
    return at < 0
  })
  ed.transact((tr: any) => tr.setSelection(TextSelection.create(tr.doc, at)))
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1
/** The context without the active-block hint the text path appends. */
const body = (context: string) => context.split('\n\n\nActive block type')[0]

const nestedDocument = () => create([
  { id: 'h', type: 'heading', props: { level: 1 }, content: 'Title' },
  { id: 'p1', type: 'paragraph', content: 'First paragraph' },
  { id: 'b1', type: 'bulletListItem', content: 'Parent item', children: [{ id: 'b2', type: 'bulletListItem', content: 'Nested child' }] },
  { id: 'p2', type: 'paragraph', content: 'Last paragraph' },
])

describe('cursor-mode Markdown context', () => {
  it.each([
    ['a paragraph', 'p1'],
    ['a parent list item', 'b1'],
    ['a nested list item', 'b2'],
    ['the last paragraph', 'p2'],
  ])('shows every block once, in place, with the caret in %s', (_label, id) => {
    const ed = nestedDocument()
    caret(ed, id, 2)
    const context = buildDocumentContext(ed)
    for (const text of ['Title', 'First paragraph', 'Parent item', 'Nested child', 'Last paragraph']) {
      expect(count(context, text), `${text} in:\n${context}`).toBe(1)
    }
    expect(count(context, CURSOR_MARKER)).toBe(1)
    expect(body(context).replace(` ${CURSOR_MARKER}`, '')).toBe('# Title\n\nFirst paragraph\n\n* Parent item\n  * Nested child\n\nLast paragraph')
  })

  it('marks the end of the caret block, nested or not', () => {
    const ed = nestedDocument()
    caret(ed, 'b2', 2)
    expect(body(buildDocumentContext(ed))).toContain(`* Parent item\n  * Nested child ${CURSOR_MARKER}\n\nLast paragraph`)
    caret(ed, 'b1', 2)
    expect(body(buildDocumentContext(ed))).toContain(`* Parent item ${CURSOR_MARKER}\n  * Nested child`)
  })

  it('leaves the lists around the caret whole: no split, no renumbering', () => {
    const ed = create([
      { id: 'b1', type: 'bulletListItem', content: 'Parent item', children: [
        { id: 'b2', type: 'bulletListItem', content: 'First child' },
        { id: 'b3', type: 'bulletListItem', content: 'Second child' },
      ] },
      { id: 'n1', type: 'numberedListItem', content: 'Step one' },
      { id: 'n2', type: 'numberedListItem', content: 'Step two' },
      { id: 'n3', type: 'numberedListItem', content: 'Step three' },
    ])
    caret(ed, 'b2', 2)
    expect(body(buildDocumentContext(ed))).toContain(`* Parent item\n  * First child ${CURSOR_MARKER}\n  * Second child`)
    caret(ed, 'n2', 2)
    expect(body(buildDocumentContext(ed))).toContain(`1. Step one\n2. Step two ${CURSOR_MARKER}\n3. Step three`)
  })

  it('puts the marker in place of an empty caret block', () => {
    const ed = create([
      { id: 'p1', type: 'paragraph', content: 'Before' },
      { id: 'e', type: 'paragraph', content: '' },
      { id: 'p2', type: 'paragraph', content: 'After' },
    ])
    caret(ed, 'e')
    expect(body(buildDocumentContext(ed))).toBe(`Before\n\n${CURSOR_MARKER}\n\nAfter`)
  })

  it('shows a document that is only its placeholder paragraph as the marker alone', () => {
    // A new editor without initial content holds one empty paragraph.
    const ed = editor = BlockNoteEditor.create({ schema: getSchema() as any })
    expect(ed.document.map((block: any) => [block.type, block.content])).toEqual([['paragraph', []]])
    expect(body(buildDocumentContext(ed))).toBe(CURSOR_MARKER)
  })

  it('puts the marker after a caret block without inline text', () => {
    const ed = create([
      { id: 'p1', type: 'paragraph', content: 'Before' },
      { id: 't', type: 'table', content: { type: 'tableContent', rows: [{ cells: ['a', 'b'] }, { cells: ['c', 'd'] }] } },
      { id: 'p2', type: 'paragraph', content: 'After' },
    ])
    // A table cell holds the caret, so resolve the table block as the anchor.
    const context = buildDocumentContext({
      document: ed.document,
      blocksToMarkdownLossy: ed.blocksToMarkdownLossy.bind(ed),
      getSelection: () => undefined,
      getTextCursorPosition: () => ({ block: { id: 't' } }),
    })
    const marker = context.indexOf(CURSOR_MARKER)
    expect(count(context, CURSOR_MARKER)).toBe(1)
    expect(context.indexOf('| c')).toBeGreaterThanOrEqual(0)
    expect(context.indexOf('| c')).toBeLessThan(marker)
    expect(context.indexOf('After')).toBeGreaterThan(marker)
  })

  it('puts the marker after a caret code block, outside its fence', () => {
    const ed = create([
      { id: 'p1', type: 'paragraph', content: 'Before' },
      { id: 'c', type: 'codeBlock', props: { language: 'python' }, content: 'x = 1' },
      { id: 'p2', type: 'paragraph', content: 'After' },
    ])
    caret(ed, 'c', 2)
    const context = body(buildDocumentContext(ed))
    expect(count(context, CURSOR_MARKER)).toBe(1)
    expect(context).toContain(`x = 1\n\`\`\`\n\n${CURSOR_MARKER}\n\nAfter`)
  })

  it('keeps a nested caret block whole when a long document is cut', () => {
    const filler = (prefix: string) => Array.from({ length: 60 }, (_, i) => ({ id: `${prefix}${i}`, type: 'paragraph', content: `Filler ${prefix}${i} ` + 'text '.repeat(40) }))
    const ed = create([
      ...filler('f'),
      { id: 'b1', type: 'bulletListItem', content: 'Parent item', children: [{ id: 'b2', type: 'bulletListItem', content: 'Nested child carries the caret' }] },
      ...filler('g'),
    ])
    caret(ed, 'b2', 2)
    const context = buildDocumentContext(ed)
    expect(context).toContain('...[truncated]')
    expect(context).toContain(`* Parent item\n  * Nested child carries the caret ${CURSOR_MARKER}`)
    expect(context).not.toContain('Filler f0 ')
    expect(context.length).toBeLessThanOrEqual(12000 + CURSOR_MARKER.length + 200)
  })
})
