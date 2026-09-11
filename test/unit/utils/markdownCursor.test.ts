import { describe, expect, it } from 'vitest'
import { blockAtMarkdownOffset, cursorPositionAtMarkdownOffset, markdownOffsetForBlock, markdownOffsetForCursor } from '../../../frontend/utils/markdownCursor'

const blocks = [
  { id: 'one', markdown: 'First' },
  { id: 'two', markdown: 'Same' },
  { id: 'three', markdown: 'Same' },
  { id: 'four', markdown: 'Fourth paragraph' },
]
const editor = {
  document: blocks,
  blocksToMarkdownLossy(selected: Array<{ id: string }>) {
    return selected.map(block => blocks.find(source => source.id === block.id)?.markdown ?? '').join('\n\n')
  },
}
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

  it('preserves the character offset across Markdown syntax', () => {
    const richBlocks = [{ id: 'heading', type: 'heading', content: [{ type: 'text', text: 'Hello' }] }]
    const richEditor = {
      document: richBlocks,
      blocksToMarkdownLossy(selected: Array<{ id: string }>) {
        return selected[0]?.id === 'heading' ? '# Hello' : ''
      },
    }
    expect(markdownOffsetForCursor(richEditor, '# Hello', 'heading', 3)).toBe(5)
    expect(cursorPositionAtMarkdownOffset(richEditor, '# Hello', 5)?.textOffset).toBe(3)
  })

  it('maps a nested active block to its top-level parent', () => {
    const nested = {
      document: [{ id: 'parent', markdown: '- Parent\n  - Child', children: [{ id: 'child' }] }],
      blocksToMarkdownLossy(selected: Array<{ id: string }>) {
        return selected[0]?.id === 'parent' ? '- Parent\n  - Child' : ''
      },
    }
    expect(markdownOffsetForBlock(nested, '- Parent\n  - Child', 'child')).toBe(0)
  })
})
