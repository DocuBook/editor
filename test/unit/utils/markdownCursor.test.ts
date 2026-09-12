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
