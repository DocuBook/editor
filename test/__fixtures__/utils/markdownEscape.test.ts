import { describe, expect, it } from 'vitest'
import { escapeBlocksForMarkdown, escapeMarkdownText, isActiveContentUrl } from '../../../frontend/utils/markdownEscape'

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

describe('isActiveContentUrl', () => {
  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>1</script>',
    'DATA:TEXT/HTML;base64,PHNjcmlwdD4=',
    'data:application/xhtml+xml,<html/>',
  ])('flags %j', (url) => {
    expect(isActiveContentUrl(url)).toBe(true)
  })

  it.each([
    'https://example.com/a?b=1',
    'http://example.com/',
    'mailto:someone@example.com',
    'tel:+15551234',
    'pics/a.png',
    '../notes/b.md',
    '#section',
    '//cdn.example.com/a.png',
    'data:image/png;base64,AAAA',
    'data:text/plain;base64,AAAA',
    'obsidian://open?vault=x',
    'file:///Users/me/doc.pdf',
    'ftp://host/f',
    '',
    'see javascript: in the middle',
  ])('leaves %j alone', (url) => {
    expect(isActiveContentUrl(url)).toBe(false)
  })

  it('treats a non-string as safe', () => {
    expect(isActiveContentUrl(undefined)).toBe(false)
    expect(isActiveContentUrl(null)).toBe(false)
    expect(isActiveContentUrl(42)).toBe(false)
  })
})

describe('escapeBlocksForMarkdown: URLs that would execute', () => {
  const media = (type: string, url: string, extra: object = {}) => ({ type, props: { url, name: 'n' }, content: undefined, children: [], ...extra })

  it.each(['image', 'video', 'audio', 'file'])('empties the URL of a %s block', (type) => {
    const [block] = escapeBlocksForMarkdown([media(type, 'javascript:alert(1)')]) as any[]

    expect(block.props.url).toBe('')
    expect(block.props.name).toBe('n')
  })

  it('empties it for a nested block as well', () => {
    const blocks = [{ type: 'bulletListItem', content: [], children: [media('file', 'vbscript:msgbox(1)')] }]

    const [item] = escapeBlocksForMarkdown(blocks) as any[]

    expect(item.children[0].props.url).toBe('')
  })

  it('leaves safe URLs, other blocks and other props alone', () => {
    const blocks = [
      media('file', 'https://example.com/f.pdf'),
      media('image', 'data:image/png;base64,AAAA'),
      media('video', 'pics/v.mp4'),
      { type: 'paragraph', content: [{ type: 'text', text: 'javascript:alert(1)', styles: {} }], props: { url: 'javascript:1' }, children: [] },
    ]

    const out = escapeBlocksForMarkdown(blocks) as any[]

    expect(out[0].props.url).toBe('https://example.com/f.pdf')
    expect(out[1].props.url).toBe('data:image/png;base64,AAAA')
    expect(out[2].props.url).toBe('pics/v.mp4')
    // Only media/file blocks carry a URL the export writes; a paragraph's text is just text.
    expect(out[3].props.url).toBe('javascript:1')
    expect(out[3].content[0].text).toBe('javascript:alert(1)')
  })

  it('does not modify the document it is given', () => {
    const blocks = [media('file', 'javascript:alert(1)')]
    const before = JSON.stringify(blocks)

    escapeBlocksForMarkdown(blocks)

    expect(JSON.stringify(blocks)).toBe(before)
  })
})
