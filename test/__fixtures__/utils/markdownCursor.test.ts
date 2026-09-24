import { describe, expect, it } from 'vitest'
import { blockAtMarkdownOffset, cursorPositionAtMarkdownOffset, markdownOffsetForBlock, markdownOffsetForCursor } from '../../../frontend/utils/markdownCursor'

const blocks = [
  { id: 'one', content: 'First' },
  { id: 'two', content: 'Same' },
  { id: 'three', content: 'Same' },
  { id: 'four', content: 'Fourth paragraph' },
]
const editor = { document: blocks }
const markdown = 'First\n\nSame\n\nSame\n\nFourth paragraph'

describe('markdown cursor mapping', () => {
  it('maps active WYSIWYG block to matching raw markdown offset', () => {
    expect(markdownOffsetForBlock(editor, markdown, 'four')).toBe(markdown.indexOf('Fourth paragraph'))
  })

  it('maps raw markdown cursor to containing WYSIWYG block', () => {
    expect(blockAtMarkdownOffset(editor, markdown, markdown.indexOf('Fourth') + 4)?.id).toBe('four')
  })

  it('maps duplicate blocks in document order', () => {
    expect(markdownOffsetForBlock(editor, markdown, 'three')).toBe(markdown.lastIndexOf('Same'))
  })

  it('preserves character offsets across Markdown syntax', () => {
    const richEditor = { document: [{ id: 'heading', content: [{ type: 'text', text: 'Hello' }] }] }
    expect(markdownOffsetForCursor(richEditor, '# **Hello**', 'heading', 3)).toBe(7)
    expect(cursorPositionAtMarkdownOffset(richEditor, '# **Hello**', 7)?.textOffset).toBe(3)
  })

  it('maps nested list blocks recursively using original source ranges', () => {
    const nested = {
      document: [{
        id: 'parent',
        content: [{ type: 'text', text: 'Parent' }],
        children: [{ id: 'child', content: [{ type: 'text', text: 'Child' }] }],
      }],
    }
    const source = '+ Parent\n  - Child'
    const childStart = source.indexOf('Child')

    expect(markdownOffsetForBlock(nested, source, 'parent')).toBe(source.indexOf('Parent'))
    expect(markdownOffsetForBlock(nested, source, 'child')).toBe(childStart)
    expect(markdownOffsetForCursor(nested, source, 'child', 3)).toBe(childStart + 3)
    expect(cursorPositionAtMarkdownOffset(nested, source, childStart + 3)).toEqual({
      block: nested.document[0].children[0],
      textOffset: 3,
    })
  })

  it('uses raw noncanonical ordered-list markers', () => {
    const listEditor = { document: [{ id: 'item', content: [{ type: 'text', text: 'Item' }] }] }
    const source = '7) Item'

    expect(markdownOffsetForBlock(listEditor, source, 'item')).toBe(source.indexOf('Item'))
  })

  it('counts emoji as two UTF-16 code units like ProseMirror', () => {
    const emojiEditor = { document: [{ id: 'emoji', content: [{ type: 'text', text: 'A😀B' }] }] }
    const source = '**A😀B**'

    expect(markdownOffsetForCursor(emojiEditor, source, 'emoji', 3)).toBe(source.indexOf('B'))
    expect(cursorPositionAtMarkdownOffset(emojiEditor, source, source.indexOf('B'))?.textOffset).toBe(3)
  })
})

describe('markdown cursor mapping across block shapes', () => {
  const cell = (text: string) => ({ content: [{ type: 'text', text }] })
  const table = (rows: string[][]) => ({ type: 'tableContent', rows: rows.map(row => ({ cells: row.map(cell) })) })

  /* A BlockNote table is ONE block holding every cell, while Markdown writes
     pipes and a header rule between them. Offsets are therefore measured across
     the whole table, which is what the caret capture reports. */
  it('maps a cursor inside every table cell, not just the first', () => {
    const editor = { document: [
      { id: 'intro', content: [{ type: 'text', text: 'Intro' }] },
      { id: 'tbl', content: table([['a', 'b'], ['1', '2']]) },
      { id: 'after', content: [{ type: 'text', text: 'After' }] },
    ] }
    const markdown = 'Intro\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nAfter'

    expect(markdownOffsetForCursor(editor, markdown, 'tbl', 0)).toBe(markdown.indexOf('a'))
    expect(markdownOffsetForCursor(editor, markdown, 'tbl', 1)).toBe(markdown.indexOf('b'))
    expect(markdownOffsetForCursor(editor, markdown, 'tbl', 2)).toBe(markdown.indexOf('1'))
    expect(markdownOffsetForCursor(editor, markdown, 'tbl', 3)).toBe(markdown.indexOf('2'))
    expect(cursorPositionAtMarkdownOffset(editor, markdown, markdown.indexOf('b'))?.textOffset).toBe(1)
    // The block after the table must not slide into the table's row: the whole
    // table collapses to a single source block so indices stay aligned.
    expect(markdownOffsetForBlock(editor, markdown, 'after')).toBe(markdown.indexOf('After'))
  })

  it('keeps table cells with inline markup aligned and grouped', () => {
    const editor = { document: [
      { id: 'tbl', content: table([['a', 'b']]) },
      { id: 'after', content: [{ type: 'text', text: 'After' }] },
    ] }
    const markdown = '| **a** | `b` |\n| --- | --- |\n\nAfter'

    expect(markdownOffsetForCursor(editor, markdown, 'tbl', 0)).toBe(markdown.indexOf('a'))
    expect(markdownOffsetForCursor(editor, markdown, 'tbl', 1)).toBe(markdown.indexOf('b'))
    expect(markdownOffsetForBlock(editor, markdown, 'after')).toBe(markdown.indexOf('After'))
  })

  it('aligns two tables with their surrounding blocks', () => {
    const editor = { document: [
      { id: 'first', content: table([['a', 'b']]) },
      { id: 'mid', content: [{ type: 'text', text: 'here' }] },
      { id: 'second', content: table([['c', 'd']]) },
    ] }
    const markdown = '| a | b |\n| --- | --- |\n\nhere\n\n| c | d |\n| --- | --- |'

    expect(markdownOffsetForCursor(editor, markdown, 'first', 1)).toBe(markdown.indexOf('b'))
    expect(markdownOffsetForBlock(editor, markdown, 'mid')).toBe(markdown.indexOf('here'))
    expect(markdownOffsetForCursor(editor, markdown, 'second', 1)).toBe(markdown.indexOf('d'))
  })

  /* A loose list item owns a first paragraph AND separate child blocks. The
     child paragraph has its own BlockNote id and must map to its own source,
     not to offset 0. */
  it('maps a list item child block to its own paragraph', () => {
    const editor = { document: [{
      id: 'item',
      content: [{ type: 'text', text: 'p1' }],
      children: [{ id: 'p2', content: [{ type: 'text', text: 'p2' }] }],
    }] }
    const markdown = '- p1\n\n  p2'

    expect(markdownOffsetForCursor(editor, markdown, 'p2', 2)).toBe(markdown.indexOf('p2') + 2)
    expect(cursorPositionAtMarkdownOffset(editor, markdown, markdown.indexOf('p2'))).toEqual({
      block: editor.document[0].children[0],
      textOffset: 0,
    })
  })

  /* A quote's paragraph break is a BlockNote hard break the Markdown source has
     no glyph for; it must not consume a source character and shift the caret. */
  it('ignores the quote paragraph break when aligning', () => {
    const editor = { document: [{ id: 'q', content: [{ type: 'text', text: 'p1\np2' }] }] }
    const markdown = '> p1\n>\n> p2'

    expect(markdownOffsetForCursor(editor, markdown, 'q', 3)).toBe(markdown.indexOf('p2'))
    expect(cursorPositionAtMarkdownOffset(editor, markdown, markdown.indexOf('p2'))?.textOffset).toBe(3)
  })

  /* GFM syntax (strikethrough, task boxes) carries markers BlockNote does not
     show. Parsing the source with the same extension set keeps those markers
     out of the alignment instead of counting them as visible characters. */
  it('skips GFM strikethrough and task markers', () => {
    const strike = { document: [{ id: 's', content: [{ type: 'text', text: 'gone' }] }] }
    const strikethrough = '~~gone~~'
    expect(markdownOffsetForCursor(strike, strikethrough, 's', 2)).toBe(strikethrough.indexOf('gone') + 2)

    const task = { document: [{ id: 't', content: [{ type: 'text', text: 'done' }] }] }
    const taskMarkdown = '- [x] done'
    expect(markdownOffsetForCursor(task, taskMarkdown, 't', 2)).toBe(taskMarkdown.indexOf('done') + 2)
  })

  /* A table of empty cells emits no mdast node inside its span. The span still
     needs a source block, otherwise the next paragraph maps into the table's
     slot and every caret after it drifts. */
  it('keeps later blocks aligned when a table has only empty cells', () => {
    const empty = () => ({ content: [{ type: 'text', text: '' }] })
    const editor = { document: [
      { id: 'tbl', content: { type: 'tableContent', rows: [{ cells: [empty(), empty()] }] } },
      { id: 'after', content: [{ type: 'text', text: 'After' }] },
    ] }
    const markdown = '|  |  |\n| --- | --- |\n\nAfter'

    expect(markdownOffsetForBlock(editor, markdown, 'after')).toBe(markdown.indexOf('After'))
    expect(markdownOffsetForCursor(editor, markdown, 'after', 2)).toBe(markdown.indexOf('After') + 2)
  })

  /* A paragraph ending in a hard break: the trailing BlockNote newline and the
     space after it have no source glyph, so a caret in that tail must reach the
     break syntax instead of collapsing back to the block start. */
  it('keeps the caret at the block end after a trailing hard break', () => {
    const editor = { document: [{ id: 'b', content: [{ type: 'text', text: 'a\n ' }] }] }
    const markdown = 'a\\\n'
    /* mdast ends the paragraph before the line break, so the furthest the caret
       can land is just after the backslash. */
    const afterBreakMarker = markdown.indexOf('\\') + 1

    expect(markdownOffsetForCursor(editor, markdown, 'b', 3)).toBe(afterBreakMarker)
    expect(markdownOffsetForCursor(editor, markdown, 'b', 2)).toBe(afterBreakMarker)
  })
})
