// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import { getSchema } from '../../../frontend/components/editor/setup'
import { mathDollarToMathML } from '../../../frontend/utils/mathMarkdown'
import { serializeMarkdown } from '../../../frontend/utils/markdownSerialization'

/** The WYSIWYG save path end to end: a note is loaded the way
 *  `loadMarkdownIntoEditor` loads it and written back the way the flush does.
 *  Any edit rewrites the whole file through this path, so code a note merely
 *  contains must survive it unchanged. */
let editor: any

beforeAll(() => {
  editor = BlockNoteEditor.create({ schema: getSchema() as any })
})

const roundTrip = (markdown: string) => {
  editor.replaceBlocks(editor.document, editor.tryParseMarkdownToBlocks(mathDollarToMathML(markdown)))
  return serializeMarkdown(editor)
}

describe('markdown round trip keeps code intact', () => {
  it.each([
    ['JSDoc in a fence', '```ts\n/**\n * Adds two numbers\n * @param a first\n */\nfunction add(a, b) {}\n```'],
    ['Makefile substitutions', '```make\nbuild:\n\t$(CC) $(CFLAGS) -o app\n```'],
    ['LaTeX listing', '```latex\n\\[ x^2 \\]\n```'],
    ['shell in inline code', 'Run `docker run -v $(pwd):/app $(IMAGE)` now'],
    ['regex in inline code', 'Match `/\\(foo\\)/` literally'],
  ])('%s', (_name, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown)
  })

  it('still round-trips math and bullets', () => {
    expect(roundTrip('- item\n\nArea $x^2$ here')).toBe('- item\n\nArea $x^2$ here')
  })
})

/** Text typed in the editor reloads as the same text, not as the Markdown
 *  syntax it happens to look like. Typed into a paragraph, the way a user does. */
describe('markdown round trip keeps typed text literal', () => {
  const reload = (text: string) => {
    editor.replaceBlocks(editor.document, [{ type: 'paragraph', content: text }])
    const markdown = serializeMarkdown(editor)!
    editor.replaceBlocks(editor.document, editor.tryParseMarkdownToBlocks(mathDollarToMathML(markdown)))
    return editor.document.map((block: any) => ({ type: block.type, content: block.content }))
  }

  it.each([
    '* starred', '- dash', '+ plus', '# hash', '> quote', '1. one', '12) paren',
    '---', '***', '___', '```', '~~~',
    'a*b*c', '_under_', '**bold**', '`tick`', '~~strike~~', '[a](b)', '![i](j)',
    '$x$ math', 'cost $5 and $x$ here', 'esc \\* star', 'esc \\( x \\)',
    '[[Wiki Note]]', 'Text[^1]', 'Paid $5 and $10', '\\$a\\$', 'a \\$b\\$ c','snake_case_name', '2 * 3 * 4',
    'line\n# second', 'line\n- second', 'line\n---', 'line\n> q',
  ])('%j', (text) => {
    const [block, ...rest] = reload(text)
    expect(rest).toEqual([])
    expect(block.type).toBe('paragraph')
    // BlockNote's parser puts one space after a hard break (stable after the first reload).
    expect(block.content.map((item: any) => item.text).join('').replace(/\n /g, '\n')).toBe(text)
    expect(block.content.every((item: any) => item.type === 'text' && Object.keys(item.styles).length === 0)).toBe(true)
  })
})

