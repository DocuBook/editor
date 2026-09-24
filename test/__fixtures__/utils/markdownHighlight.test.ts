import { describe, expect, it } from 'vitest'
import { highlightMarkdown, markdownTokenClass, markdownTokenText, type MarkdownToken, type MarkdownTokenKind } from '../../../frontend/utils/markdownHighlight'

/** Every kind in document order — container kinds (heading, quote, strong, …)
 *  included, since those carry the colour for their whole subtree. */
function kinds(source: string): MarkdownTokenKind[] {
  const walk = (tokens: MarkdownToken[]): MarkdownTokenKind[] =>
    tokens.flatMap(token => token.children ? [token.kind, ...walk(token.children)] : [token.kind])
  return walk(highlightMarkdown(source))
}

function leafTexts(source: string, kind: MarkdownTokenKind): string[] {
  const leaves = (tokens: MarkdownToken[]): { kind: MarkdownTokenKind; text: string }[] =>
    tokens.flatMap(token => token.children ? leaves(token.children) : [{ kind: token.kind, text: token.text ?? '' }])
  return leaves(highlightMarkdown(source)).filter(leaf => leaf.kind === kind).map(leaf => leaf.text)
}

/** Covers every construct the WYSIWYG round-trips, plus an unclosed fence. */
const SAMPLE = [
  '---',
  'title: Note',
  '# comment',
  'tags:',
  '---',
  '',
  '# Heading',
  '',
  'Body with **bold**, *italic*, `code`, ~~strike~~, [[Wiki Note]], $x^2$, and [a link](https://example.com "t").',
  '',
  '> quoted **text**',
  '',
  '- [x] done',
  '- [ ] todo',
  '1. ordered',
  '',
  '```ts',
  'const a = 1',
  '```',
  '',
  '| a | b |',
  '| --- | --- |',
  '',
  '---',
  '',
  'unclosed:',
  '```',
  'still code',
].join('\n')

describe('markdown highlighter', () => {
  it('reproduces the source byte-for-byte', () => {
    expect(markdownTokenText(highlightMarkdown(SAMPLE))).toBe(SAMPLE)
  })

  it('is lossless for empty input and mixed line endings', () => {
    expect(markdownTokenText(highlightMarkdown(''))).toBe('')
    expect(markdownTokenText(highlightMarkdown('a\r\n> b\r\n'))).toBe('a\r\n> b\r\n')
  })

  it('colours every construct the WYSIWYG can represent', () => {
    const found = new Set(kinds(SAMPLE))
    for (const kind of ['heading', 'strong', 'emphasis', 'strike', 'codeSpan', 'wikilink', 'math', 'linkUrl', 'taskMarker', 'listMarker', 'quote', 'codeLang', 'code', 'frontmatterKey', 'tableSeparator', 'hr'] as const) {
      expect(found, `missing ${kind}`).toContain(kind)
    }
  })

  it('keeps frontmatter key/value split on the first colon', () => {
    expect(leafTexts('---\ntitle: a: b\n---\n', 'frontmatterKey')).toEqual(['title'])
    expect(leafTexts('---\ntitle: a: b\n---\n', 'frontmatterValue')).toEqual([' a: b'])
  })

  /* A bare URL line has no key to split off; `https` coloured as a key was the
     colon of the scheme being read as a separator. */
  it('treats a bare url line in frontmatter as a value', () => {
    const frontmatter = '---\nlinks:\n- https://a.test\n---\n'
    expect(leafTexts(frontmatter, 'frontmatterKey')).toEqual(['links'])
    expect(leafTexts(frontmatter, 'frontmatterValue')).toEqual(['- https://a.test'])
    expect(leafTexts('---\nurl: https://a.test\n---\n', 'frontmatterValue')).toEqual([' https://a.test'])
  })

  it('treats an unterminated frontmatter opener as a horizontal rule', () => {
    expect(kinds('---\n\nbody')).toContain('hr')
  })

  it('marks the fenced code body and its language', () => {
    expect(leafTexts('```mermaid\ngraph TD;\n```\n', 'codeLang')).toEqual(['mermaid'])
    expect(leafTexts('```mermaid\ngraph TD;\n```\n', 'code')).toEqual(['graph TD;\n'])
  })

  it('keeps an unclosed fence coloured to the end of the file', () => {
    expect(leafTexts('```\nabc\ndef', 'code')).toEqual(['abc\n', 'def'])
  })

  it('does not colour snake_case or arithmetic as emphasis', () => {
    expect(kinds('snake_case_name')).not.toContain('emphasis')
    expect(kinds('2 * 3')).not.toContain('emphasis')
    expect(kinds('**a**')).toContain('strong')
  })

  it('does not colour emphasis inside a code span', () => {
    expect(leafTexts('`a*b*c`', 'codeSpan')).toEqual(['a*b*c'])
    expect(kinds('`a*b*c`')).not.toContain('emphasis')
  })

  it('keeps a wikilink distinct from a markdown link', () => {
    expect(leafTexts('[[Wiki Note]]', 'wikilink')).toEqual(['[[Wiki Note]]'])
    expect(leafTexts('[text](target)', 'wikilink')).toEqual([])
    expect(leafTexts('[text](target)', 'linkUrl')).toEqual(['target'])
  })

  it('escapes punctuation instead of opening a mark', () => {
    expect(kinds('\\*not italic\\*')).toContain('escape')
    expect(kinds('\\*not italic\\*')).not.toContain('emphasis')
  })

  it('maps every kind to a css class or plain text', () => {
    expect(markdownTokenClass('plain')).toBe('')
    expect(markdownTokenClass('wikilink')).toBe('md-wikilink')
    expect(markdownTokenClass('frontmatterKey')).toBe('md-frontmatter-key')
  })

  it('keeps the app dialect intact when the tokenizer splits the text', () => {
    /* `[[` cannot open a link, so micromark cuts the paragraph into adjacent
       `data` tokens; the overlay still has to see one contiguous run. */
    expect(leafTexts('Body [[Wiki Note]] tail', 'wikilink')).toEqual(['[[Wiki Note]]'])
    expect(leafTexts('a [[one]] b [[two]]', 'wikilink')).toEqual(['[[one]]', '[[two]]'])
  })

  it('colours each syntax marker from its own token', () => {
    expect(leafTexts('# H', 'marker')).toEqual(['#'])
    expect(leafTexts('## H ##', 'marker')).toEqual(['##', '##'])
    expect(leafTexts('setext\n======\n', 'marker')).toEqual(['======'])
    expect(leafTexts('> a\n>> b\n', 'marker')).toEqual(['>', '>', '>'])
    expect(leafTexts('a **b** ~~c~~\n', 'marker')).toEqual(['**', '**', '~~', '~~'])
    expect(leafTexts('a *i* and _e_\n', 'marker')).toEqual(['*', '*', '_', '_'])
    expect(leafTexts('a  \nb\
c\n', 'marker')).toEqual(['  '])
  })

  it('colours fences, list markers, task boxes and table pipes', () => {
    const fenced = '```ts\nconst a = 1\n```\n'
    expect(kinds(fenced)).toContain('codeFence')
    expect(leafTexts(fenced, 'marker')).toEqual(['```', '```'])
    expect(leafTexts('- [x] done\n- [ ] todo\n', 'taskMarker')).toEqual(['[x]', '[ ]'])
    expect(leafTexts('- a\n1. b\n', 'listMarker')).toEqual(['-', '1', '.'])
    const table = '| a | b |\n| - | - |\n'
    expect(leafTexts(table, 'tablePipe')).toEqual(['|', '|', '|', '|', '|', '|'])
    expect(leafTexts(table, 'tableSeparator')).toEqual(['-', '-'])
  })

  it('wraps every container the tree may nest', () => {
    for (const [source, kind] of [
      ['# H\n', 'heading'],
      ['> q\n', 'quote'],
      ['**b**\n', 'strong'],
      ['*e*\n', 'emphasis'],
      ['~~s~~\n', 'strike'],
      ['[t](u)\n', 'link'],
      ['![a](i.png)\n', 'link'],
    ] as const) {
      expect(kinds(source), source).toContain(kind)
    }
  })

  it('resolves urls from links, images, definitions and autolinks', () => {
    expect(leafTexts('[t](url "title")\n', 'linkUrl')).toEqual(['url'])
    expect(leafTexts('![alt](img.png)\n', 'linkUrl')).toEqual(['img.png'])
    expect(leafTexts('[ref]: /target "t"\n', 'linkUrl')).toEqual(['/target'])
    expect(leafTexts('<https://x.test>\n', 'linkUrl')).toEqual(['https://x.test'])
    expect(leafTexts('https://bare.test\n', 'linkUrl')).toEqual(['https://bare.test'])
    expect(leafTexts('www.b.test\n', 'linkUrl')).toEqual(['www.b.test'])
    expect(leafTexts('me@x.test\n', 'linkUrl')).toEqual(['me@x.test'])
  })

  it('colours escapes and html as their own construct', () => {
    expect(leafTexts('a \\* b\n', 'escape')).toEqual(['\\*'])
    expect(leafTexts('a\\\nb\n', 'escape')).toEqual(['\\'])
    expect(leafTexts('<div>x</div>\n', 'html')).toEqual(['<div>x</div>'])
    expect(leafTexts('a <b>c</b>\n', 'html')).toEqual(['<b>', '</b>'])
  })

  it('marks frontmatter comment lines and both delimiters', () => {
    expect(leafTexts('---\n# c\n---\n', 'marker')).toEqual(['---', '# c', '---'])
  })

  it('keeps offsets aligned on CRLF sources', () => {
    expect(kinds('a\r\n> b\r\n')).toContain('quote')
    expect(leafTexts('a\r\n> b\r\n', 'marker')).toEqual(['>'])
  })

  it('locks the syntax tokens the mapping table leans on', () => {
    /* Each case names the micromark token it pins, so a rename upstream fails
       here instead of silently dropping a glyph back to plain text. */
    // codeTextSequence — the backtick run on each side of a code span.
    expect(leafTexts('`a*b*c`\n', 'marker')).toEqual(['`', '`'])
    expect(leafTexts('``a`b``\n', 'marker')).toEqual(['``', '``'])
    // tableCellDivider — every pipe, header, delimiter row and body alike.
    expect(leafTexts('| a | b |\n| - | - |\n| 1 | 2 |\n', 'tablePipe')).toEqual(Array(9).fill('|'))
    // characterEscape — the backslash and its punctuation are one token.
    expect(leafTexts('a \\* b \\[c\\]\n', 'escape')).toEqual(['\\*', '\\[', '\\]'])
  })

  it('reaches every kind in the colour table', () => {
    /* A construct that loses its mapping falls back to `plain`, so this fails
       the moment an entry is dropped or a new kind is never produced. */
    const ALL_KINDS: MarkdownTokenKind[] = [
      'plain', 'marker', 'heading', 'quote', 'listMarker', 'taskMarker', 'code',
      'codeSpan', 'codeFence', 'codeLang', 'frontmatterKey', 'frontmatterValue',
      'tablePipe', 'tableSeparator', 'strong', 'emphasis', 'strike', 'escape',
      'html', 'link', 'linkUrl', 'wikilink', 'math', 'hr',
    ]
    const EVERYTHING = [
      '---',
      'title: Note',
      '---',
      '',
      '# Heading',
      '',
      'Body **bold** *em* ~~strike~~ `code` [[Wiki]] $x$ and <span>html</span> then \\* escaped.',
      '',
      '> quoted',
      '',
      '- [x] done',
      '1. ordered',
      '',
      '```ts',
      'const a = 1',
      '```',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '---',
      '',
      '[a link](https://example.com)',
    ].join('\n')
    expect(markdownTokenText(highlightMarkdown(EVERYTHING))).toBe(EVERYTHING)
    expect(new Set(kinds(EVERYTHING))).toEqual(new Set(ALL_KINDS))
  })

  /* Losslessness is the safety net: a token that invents or drops a character
     shifts the caret, so every fixture has to survive a round-trip. */
  it('is lossless across every construct the raw editor can meet', () => {
    const fixtures = [
      SAMPLE,
      '',
      '\n',
      '\n\n\n',
      'no trailing newline',
      '> a\n>\n> b\n',
      '>> nested\n',
      '## H ##\n',
      'tags:\n---\n',
      '---\ndate: 2024-01-02\n---\n',
      '---\n\nbody\n',
      '- [x] done\n- [ ] todo\n',
      '- a\n  - nested\n',
      '1. ordered\n2. more\n',
      '| a | b |\n| --- | --- |\n| 1 | 2 |\n',
      '| a | b |\n| --- | --- |\n',
      '```ts\nconst a = 1\n```\n',
      '```\nunclosed\n',
      '    indented code\n',
      '~~gone~~ and **bold** and *em*\n',
      '`a*b*c` and ``a`b``\n',
      '[[Wiki Note]] and $x^2$ and $$y$$\n',
      '[a link](https://example.com "t")\n',
      '![alt](img.png)\n',
      '[ref]: /target "t"\n\n[ref]\n',
      '<https://x.test> and https://bare.test and www.b.test\n',
      '\\*not italic\\* and \\[bracket\\]\n',
      'a  \nb\\\nc\n',
      '**bold across\nlines**\n',
      'text with | pipe outside a table\n',
      '```mermaid\ngraph TD;\n  A-->B\n```\n\n# after\n',
      '> ```\n> code\n> ```\n',
      '>\n> ```\n> code\n> ```\n',
      '> text\n>\n> ```\n> code\n> ```\n',
      '- item\n\n  ```\n  code\n  ```\n',
      '1. item\n\n   ```\n   code\n   ```\n',
      '>     indented code\n',
    ]
    for (const fixture of fixtures) {
      expect(markdownTokenText(highlightMarkdown(fixture)), JSON.stringify(fixture)).toBe(fixture)
    }
  })

  /* Inside a container micromark's in-fence `lineEnding` spans the newline *and*
     the next line's container prefix, which the container's own tokens cover too.
     Emitting both duplicated the prefix and shifted the caret by it. */
  it('is lossless for a fence nested in a container', () => {
    const nested = '>\n> ```\n> code\n> ```\n'
    expect(markdownTokenText(highlightMarkdown(nested))).toBe(nested)
    expect(leafTexts(nested, 'code')).toEqual(['code\n> '])
  })
})
