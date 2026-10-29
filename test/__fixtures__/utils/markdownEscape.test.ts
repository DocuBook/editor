import { describe, expect, it } from 'vitest'
import { escapeBlocksForMarkdown, escapeMarkdownText } from '../../../frontend/utils/markdownEscape'

describe('escapeMarkdownText', () => {
  it.each([
    ['* starred', '\\* starred'],
    ['- dash', '\\- dash'],
    ['+ plus', '\\+ plus'],
    ['# hash', '\\# hash'],
    ['> quote', '\\> quote'],
    ['1. one', '1\\. one'],
    ['12) paren', '12\\) paren'],
    ['---', '\\---'],
    ['```', '\\`\\`\\`'],
    ['~~~', '\\~\\~\\~'],
    ['a*b*c', 'a\\*b\\*c'],
    ['_under_', '\\_under\\_'],
    ['`tick`', '\\`tick\\`'],
    ['~~strike~~', '\\~\\~strike\\~\\~'],
    ['[a](b)', '\\[a](b)'],
    ['$x$ math', '\\$x\\$ math'],
    ['esc \\* star', 'esc \\\\\\* star'],
    ['line\n# second', 'line\n\\# second'],
    ['line\n---', 'line\n\\---'],
  ])('escapes %j', (text, expected) => {
    expect(escapeMarkdownText(text, true)).toBe(expected)
  })

  it.each([
    'Paid $5 and $10',
    'snake_case_name',
    '2 * 3 * 4',
    'a ~ b and ~one~',
    'back\\slash',
    '[[Wiki Note]] and [[_index]] and [[a*b]]',
    'Text[^1] and [^note]',
    'see https://x.y/_priv*x and www.a_b.com/_x',
    '| a | b |',
  ])('leaves %j as is', (text) => {
    expect(escapeMarkdownText(text, true)).toBe(text)
  })

  it('escapes block syntax only at the start of a line', () => {
    expect(escapeMarkdownText('# not a heading mid-line', false)).toBe('# not a heading mid-line')
    expect(escapeMarkdownText('a\n# b', false)).toBe('a\n\\# b')
  })
})

describe('escapeBlocksForMarkdown', () => {
  it('escapes prose blocks, their children, links and table cells', () => {
    const blocks = [
      {
        type: 'bulletListItem',
        content: [{ type: 'text', text: '# x', styles: {} }, { type: 'link', href: 'u', content: [{ type: 'text', text: '*y*', styles: {} }] }],
        children: [{ type: 'paragraph', content: [{ type: 'text', text: '1. z', styles: {} }], children: [] }],
      },
      {
        type: 'table',
        content: { type: 'tableContent', rows: [{ cells: [{ type: 'tableCell', content: [{ type: 'text', text: '`c`', styles: {} }] }] }] },
        children: [],
      },
    ]

    const [list, table] = escapeBlocksForMarkdown(blocks) as any[]

    expect(list.content[0].text).toBe('\\# x')
    expect(list.content[1].content[0].text).toBe('\\*y\\*')
    expect(list.children[0].content[0].text).toBe('1\\. z')
    expect(table.content.rows[0].cells[0].content[0].text).toBe('\\`c\\`')
  })

  it('never escapes code: code blocks, math, diagrams and code-styled text', () => {
    const blocks = [
      { type: 'codeBlock', content: [{ type: 'text', text: '* $(a) $(b)', styles: {} }], children: [] },
      { type: 'diagram', content: [{ type: 'text', text: 'A --> B', styles: {} }], children: [] },
      { type: 'paragraph', content: [{ type: 'text', text: '*a*', styles: { code: true } }], children: [] },
    ]

    expect(escapeBlocksForMarkdown(blocks)).toEqual(blocks)
  })

  it('does not modify the document it is given', () => {
    const blocks = [{ type: 'paragraph', content: [{ type: 'text', text: '# x', styles: {} }], children: [] }]
    const before = JSON.stringify(blocks)

    escapeBlocksForMarkdown(blocks)

    expect(JSON.stringify(blocks)).toBe(before)
  })
})
