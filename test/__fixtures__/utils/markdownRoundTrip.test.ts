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
    '[[Wiki Note]]', 'Text[^1]', 'Paid $5 and $10', '\\$a\\$', 'a \\$b\\$ c', 'snake_case_name', '2 * 3 * 4',
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


/** Structure built in the editor survives a save and a reload — twice, since a
 *  shape that reloads as something slightly different only breaks on the next
 *  save. BlockNote's own exporter flattens a list item's non-list children and
 *  writes a toggle as a plain bullet; markdownSerialization lays those out. */
describe('markdown round trip keeps block structure', () => {
  const t = (text: string, styles: Record<string, unknown> = {}) => ({ type: 'text', text, styles })
  const shape = (blocks: any[]): any[] => blocks.map(block => ({
    type: block.type,
    ...(block.props?.start ? { start: block.props.start } : {}),
    ...(block.type === 'checkListItem' ? { checked: block.props.checked } : {}),
    text: Array.isArray(block.content) ? block.content.map((item: any) => `${item.text ?? item.type}:${Object.keys(item.styles ?? {}).join('+')}`).join('|') : '',
    children: shape(block.children ?? []),
  }))
  const saveAndReload = () => {
    const markdown = serializeMarkdown(editor)!
    editor.replaceBlocks(editor.document, editor.tryParseMarkdownToBlocks(mathDollarToMathML(markdown)))
    return markdown
  }

  it.each<[string, any[]]>([
    ['paragraph under a bullet', [{ type: 'bulletListItem', content: 'a', children: [{ type: 'paragraph', content: 'under a' }] }, { type: 'bulletListItem', content: 'b' }]],
    ['code and quote under a bullet', [{ type: 'bulletListItem', content: 'a', children: [{ type: 'codeBlock', props: { language: 'js' }, content: 'x\n  y' }, { type: 'quote', content: 'q' }] }]],
    ['divider under a bullet', [{ type: 'bulletListItem', content: 'a', children: [{ type: 'divider' }] }]],
    ['paragraph under a numbered item, numbering kept', [{ type: 'numberedListItem', content: 'a' }, { type: 'numberedListItem', content: 'b', children: [{ type: 'paragraph', content: 'under b' }] }, { type: 'numberedListItem', content: 'c' }]],
    ['numbered list starting at 9, split by a child', [{ type: 'numberedListItem', props: { start: 9 }, content: 'nine', children: [{ type: 'paragraph', content: 'x' }] }, { type: 'numberedListItem', content: 'ten' }]],
    ['paragraph under a checklist item', [{ type: 'checkListItem', props: { checked: true }, content: 'task', children: [{ type: 'paragraph', content: 'note' }] }]],
    ['tight nested list', [{ type: 'bulletListItem', content: 'a', children: [{ type: 'bulletListItem', content: 'a1' }] }, { type: 'bulletListItem', content: 'b' }]],
    ['toggle', [{ type: 'toggleListItem', content: 'toggle', children: [{ type: 'paragraph', content: 'inside' }] }]],
    ['empty toggle', [{ type: 'toggleListItem', content: 'empty' }, { type: 'paragraph', content: 'after' }]],
    ['toggle with rich summary, nested toggle and list', [{
      type: 'toggleListItem',
      content: [t('bold', { bold: true }), t(' <kbd> & $x$ [[Wiki]]')],
      children: [
        { type: 'bulletListItem', content: 'x', children: [{ type: 'paragraph', content: 'y' }] },
        { type: 'toggleListItem', content: 'inner', children: [{ type: 'paragraph', content: 'deep' }] },
      ],
    }]],
    ['hard break in a bullet', [{ type: 'bulletListItem', content: 'line\n# second' }, { type: 'bulletListItem', content: 'next' }]],
    ['hard break in a nested numbered item', [{ type: 'bulletListItem', content: 'a', children: [{ type: 'numberedListItem', content: 'line\nsecond' }] }]],
    ['hard break in a checklist item', [{ type: 'checkListItem', props: { checked: false }, content: 'line\nsecond' }]],
    ['hard break in a heading', [{ type: 'heading', props: { level: 2 }, content: 'line\nsecond' }]],
  ])('%s', (_name, blocks) => {
    editor.replaceBlocks(editor.document, blocks)
    const want = shape(editor.document)

    const first = saveAndReload()
    expect(shape(editor.document)).toEqual(want)
    expect(saveAndReload()).toBe(first)
    expect(shape(editor.document)).toEqual(want)
  })

  it('writes the shapes other Markdown tools read too', () => {
    const markdownOf = (blocks: any[]) => {
      editor.replaceBlocks(editor.document, blocks)
      return serializeMarkdown(editor)
    }

    expect(markdownOf([{ type: 'toggleListItem', content: 'toggle', children: [{ type: 'paragraph', content: 'inside' }] }]))
      .toBe('<details>\n<summary>toggle</summary>\n\ninside\n\n</details>')
    expect(markdownOf([{ type: 'bulletListItem', content: 'a', children: [{ type: 'paragraph', content: 'under a' }] }]))
      .toBe('- a\n\n  under a')
    expect(markdownOf([{ type: 'heading', props: { level: 2 }, content: 'line\nsecond' }])).toBe('## line<br>second')
    expect(markdownOf([{ type: 'paragraph', content: 'a' }, { type: 'divider' }, { type: 'paragraph', content: 'b' }])).toBe('a\n\n---\n\nb')
  })

  /** Limits of BlockNote's parser, pinned so a change is noticed. */
  it('keeps the text of a toggle nested in a list item, as a bullet', () => {
    // A `<details>` inside a list item makes the parser drop the item's own text.
    editor.replaceBlocks(editor.document, [{ type: 'bulletListItem', content: 'item', children: [{ type: 'toggleListItem', content: 't', children: [{ type: 'paragraph', content: 'in' }] }] }])

    saveAndReload()

    expect(shape(editor.document)).toEqual(shape([{ type: 'bulletListItem', content: [t('item')], children: [{ type: 'bulletListItem', content: [t('t')], children: [{ type: 'paragraph', content: [t('in')] }] }] }]))
  })
})
