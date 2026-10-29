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
    // A reader decodes character references in a link destination, so these ARE
    // `javascript:` to it although none is one as written.
    'jav&#x61;script:alert(1)',
    'jav&#X61;script:alert(1)',
    'jav&#97;script:alert(1)',
    '&#106;&#97;&#118;&#97;script:alert(1)',
    '&#x6A;&#x61;&#x76;&#x61;script:alert(1)',
    'javascript&colon;alert(1)',
    'javascript&#58;alert(1)',
    'JAVASCRIPT&COLON;alert(1)',
    'java&Tab;script:alert(1)',
    'java&NewLine;script:alert(1)',
    'java&#9;script:alert(1)',
    'vb&#x73;cript:msgbox(1)',
    'data&colon;text/html,<script>1</script>',
    'jav&#x61script:alert(1)',
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
    // One decoding pass, like the reader's: `&amp;` decodes to a literal `&`, so the
    // result is the text `&#x61;`, not the letter, and no scheme is rebuilt.
    'jav&amp;#x61;script:alert(1)',
    'javascript&amp;colon;alert(1)',
    // Not a reference, or one that cannot be a character.
    'jav&#x110000;script:alert(1)',
    'jav&#0;script:alert(1)',
    'jav&notaref;script:alert(1)',
    'https://example.com/?q=&#x61;&colon;',
    'pics/a&#x2e;png',
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

  it.each(['jav&#x61;script:alert(1)', 'javascript&colon;alert(1)'])('empties the URL %j of a file block too', (url) => {
    const [block] = escapeBlocksForMarkdown([media('file', url)]) as any[]

    expect(block.props.url).toBe('')
  })

  it('does not modify the document it is given', () => {
    const blocks = [media('file', 'javascript:alert(1)')]
    const before = JSON.stringify(blocks)

    escapeBlocksForMarkdown(blocks)

    expect(JSON.stringify(blocks)).toBe(before)
  })

  describe('inline links', () => {
    const text = (value: string) => ({ type: 'text', text: value, styles: {} })
    const link = (href: string) => ({ type: 'link', href, content: [text('click')] })

    it.each(['javascript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,x', 'jav&#x61;script:alert(1)', 'javascript&colon;alert(1)', 'java&Tab;script:alert(1)'])(
      'replaces a link to %j with its text, in prose and in table cells',
      (href) => {
        const blocks = [
          { type: 'paragraph', content: [link(href), text(' and '), link('https://example.com/')], children: [] },
          { type: 'table', content: { type: 'tableContent', rows: [{ cells: [[link(href)]] }] }, children: [] },
        ]

        const [paragraph, table] = escapeBlocksForMarkdown(blocks) as any[]

        expect(paragraph.content.map((item: any) => item.type)).toEqual(['text', 'text', 'link'])
        expect(paragraph.content[0].text).toBe('click')
        expect(paragraph.content[2].href).toBe('https://example.com/')
        expect(table.content.rows[0].cells[0].map((item: any) => item.type)).toEqual(['text'])
      },
    )

    it.each(['https://example.com/a', 'mailto:someone@example.com', 'pics/a.md', 'obsidian://open?vault=x', 'jav&amp;#x61;script:alert(1)'])('keeps a link to %j', (href) => {
      const [paragraph] = escapeBlocksForMarkdown([{ type: 'paragraph', content: [link(href)], children: [] }]) as any[]

      expect(paragraph.content[0]).toMatchObject({ type: 'link', href })
    })
  })
})

