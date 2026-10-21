// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import { getSchema } from '../../../frontend/components/editor/setup'
import { mathDollarToMathML } from '../../../frontend/utils/mathMarkdown'

/** The editor's ingestion boundary: Markdown (from a file, or from the model)
 *  is converted to HTML and parsed against the app's schema. These tests pin
 *  what that boundary accepts, because "only components the app controls may
 *  render" is a security property, not an implementation detail.
 *
 *  The parser is the allowlist: a construct survives only if a block/inline
 *  spec declares a parse rule for it. Everything else is dropped by the spec
 *  (unknown tags, event handlers, `style`, `srcset`, `javascript:` hrefs) or
 *  ignored outright (`script`, `style`, `iframe`, `object`, `base`, `meta`,
 *  `link`). A real editor is created here — headless is enough for parsing and
 *  the suite already does it for the schema tests. */
let editor: any

beforeAll(() => {
  editor = BlockNoteEditor.create({ schema: getSchema() as any })
})

const parse = (markdown: string) => editor.tryParseMarkdownToBlocks(markdown)
const serialized = (markdown: string) => JSON.stringify(parse(markdown))

/** Every inline node in the document, flattened — links and custom inline
 *  content nest their children. */
const inlineNodes = (blocks: any[]): any[] =>
  blocks.flatMap((block) => [
    ...(Array.isArray(block.content) ? block.content : []),
    ...inlineNodes(block.children ?? []),
  ])

describe('markdown ingestion — raw HTML cannot smuggle execution primitives', () => {
  it('drops event handler attributes from raw HTML', () => {
    const [block] = parse('<img src=x onerror="alert(1)">')

    expect(block.type).toBe('image')
    expect(block.props.url).toBe('x')
    expect(serialized('<img src=x onerror="alert(1)">')).not.toContain('onerror')
  })

  it('drops the attribute from other elements too', () => {
    const out = serialized('<p onmouseover="alert(1)" style="background:url(https://evil.example/x)">hover</p>')

    expect(out).not.toContain('onmouseover')
    // `backgroundColor` is a block prop; the ATTRIBUTE (`background:url(…)`)
    // must be gone, along with the URL it would have fetched.
    expect(out).not.toContain('background:')
    expect(out).not.toContain('url(')
    expect(out).not.toContain('evil.example')
    expect(out).toContain('hover')
  })

  it('refuses javascript: link targets', () => {
    const blocks = parse('<a href="javascript:alert(1)">click</a>')

    expect(inlineNodes(blocks).some((node) => node.type === 'link')).toBe(false)
    expect(JSON.stringify(blocks)).not.toContain('javascript:')
    expect(JSON.stringify(blocks)).toContain('click')
  })

  it('refuses data: link targets', () => {
    const blocks = parse('<a href="data:text/html,<script>alert(1)</script>">click</a>')

    expect(inlineNodes(blocks).some((node) => node.type === 'link')).toBe(false)
  })

  it('keeps an ordinary web link', () => {
    const blocks = parse('[docs](https://example.com/page)')
    const link = inlineNodes(blocks).find((node) => node.type === 'link')

    expect(link?.href).toBe('https://example.com/page')
  })

  it('removes script, style, iframe, object, base, meta and link elements', () => {
    for (const html of [
      '<script>alert(1)</script>',
      '<style>body{background:url(https://evil.example)}</style>',
      '<iframe src="https://evil.example"></iframe>',
      '<object data="https://evil.example/x.swf"></object>',
      '<base href="https://evil.example/">',
      '<meta http-equiv="refresh" content="0;url=https://evil.example">',
      '<link rel="stylesheet" href="https://evil.example/x.css">',
    ]) {
      const out = serialized(html)

      expect(out).not.toContain('alert(1)')
      expect(out).not.toContain('evil.example')
    }
  })

  it('drops an svg element rather than rendering it inline', () => {
    const out = serialized('<svg onload="alert(1)"></svg>')

    expect(out).not.toContain('svg')
    expect(out).not.toContain('onload')
  })

  it('keeps text around a dropped element', () => {
    const out = serialized('<p>a<script>alert(1)</script>b</p>')

    expect(out).toContain('ab')
    expect(out).not.toContain('alert')
  })

  it('drops srcset, which would otherwise pick its own remote source', () => {
    const out = serialized('<img src="x.png" srcset="https://evil.example/a.png 2x">')

    expect(out).not.toContain('evil.example')
    expect(out).toContain('x.png')
  })
})

describe('markdown ingestion — only schema-recognized constructs are created', () => {
  it('maps a raw <img> to the image block', () => {
    const [block] = parse('<img src="pic.png" alt="a photo">')

    expect(block.type).toBe('image')
    expect(block.props).toMatchObject({ url: 'pic.png', name: 'a photo' })
  })

  it('maps markdown image syntax to the image block', () => {
    const [block] = parse('![alt](pic.png)')

    expect(block.type).toBe('image')
    expect(block.props).toMatchObject({ url: 'pic.png', name: 'alt' })
  })

  it('maps <details>/<summary> to the toggle block', () => {
    const [block] = parse('<details><summary>title</summary>body</details>')

    expect(block.type).toBe('toggleListItem')
    expect(block.children[0].type).toBe('paragraph')
  })

  it('maps a checkbox input to the check-list item', () => {
    const [block] = parse('<ul><li><input type="checkbox" checked><p>done</p></li></ul>')

    expect(block.type).toBe('checkListItem')
    expect(block.props.checked).toBe(true)
  })

  it('maps a markdown task list to the check-list item', () => {
    const [block] = parse('- [x] done')

    expect(block.type).toBe('checkListItem')
    expect(block.props.checked).toBe(true)
  })

  it('maps a markdown table to the table block', () => {
    const [block] = parse('| a | b |\n| --- | --- |\n| 1 | 2 |')

    expect(block.type).toBe('table')
  })

  it('maps $$…$$ to the math block and keeps the TeX as content', () => {
    const [block] = editor.tryParseMarkdownToBlocks(mathDollarToMathML('$$\n\\frac{1}{2}\n$$'))

    expect(block.type).toBe('mathBlock')
    expect(JSON.stringify(block.content)).toContain('\\frac{1}{2}')
  })

  it('keeps a dangerous TeX command as inert source for KaTeX to reject', () => {
    const blocks = editor.tryParseMarkdownToBlocks(
      mathDollarToMathML('$$\\href{javascript:alert(1)}{x}$$'),
    )

    // The source reaches KaTeX as text; the trust pin (mathRenderCache) is what
    // turns it into an "unsupported command" instead of an anchor.
    expect(blocks[0].type).toBe('mathBlock')
    expect(JSON.stringify(blocks)).not.toContain('href=')
  })

  it('does not let an <img> hide inside canonical math markup', () => {
    const html = '<math display="block"><annotation encoding="application/x-tex">x</annotation><img src=x onerror="alert(1)"></math>'
    const blocks = parse(html)

    expect(JSON.stringify(blocks)).not.toContain('onerror')
    expect(JSON.stringify(blocks)).not.toContain('image')
  })
})
