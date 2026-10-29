import { mapProse } from './markdownCode'
import { escapeBlocksForMarkdown } from './markdownEscape'
import { mathDollarToMathML } from './mathMarkdown'

interface MarkdownEditor<Block> {
  document: Block[]
  blocksToMarkdownLossy: (blocks?: Block[]) => string
  /** Used for a toggle's summary; without it toggles are written as BlockNote does. */
  blocksToHTMLLossy?: (blocks?: Block[]) => string
}

type AnyBlock = { type?: string; props?: Record<string, unknown>; content?: unknown; children?: AnyBlock[] }

const LIST_ITEMS = new Set(['bulletListItem', 'numberedListItem', 'checkListItem'])

/** BlockNote nests a list item's child LISTS correctly, but writes every other
 *  child (paragraph, code, quote, divider…) after the list, unindented — its
 *  HTML exporter puts them outside the `<li>`. Such a subtree is laid out here. */
const nestsCleanly = (block: AnyBlock): boolean =>
  !block.children?.length || (LIST_ITEMS.has(block.type!) && block.children.every(child => LIST_ITEMS.has(child.type!) && nestsCleanly(child)))

const indent = (markdown: string, width: number) =>
  markdown.split('\n').map(line => (line ? ' '.repeat(width) + line : line)).join('\n')

/** Escape `$` in toggle-summary HTML when the load path would read a pair of
 *  them as math (it turns `\$` back into `$`). */
function escapeSummaryDollars(html: string): string {
  if (mathDollarToMathML(html) === html) return html
  let out = ''
  for (const ch of html) out += ch === '$' ? '\\$' : ch
  return out
}

/** Serialize sibling blocks. BlockNote writes each block's content (escaped
 *  first, see markdownEscape); runs of blocks it nests correctly go to it in one
 *  call so lists stay tight and numbered. `underListItem`: these are a list
 *  item's children, where a `<details>` is not parsed back (its parser drops the
 *  item's own text), so a toggle there is written as a bullet. */
function serializeBlocks<Block>(editor: MarkdownEditor<Block>, blocks: AnyBlock[], underListItem: boolean): string {
  const parts: string[] = []
  let run: AnyBlock[] = []
  const write = (group: AnyBlock[]) => editor.blocksToMarkdownLossy(escapeBlocksForMarkdown(group as Block[])).replace(/^\n+|\s+$/g, '')
  const flush = () => {
    if (run.length) parts.push(write(run))
    run = []
  }

  let number = 0
  let previous: AnyBlock | undefined
  const queue = [...blocks]
  while (queue.length) {
    let block = queue.shift()!
    // Numbering is the item's place in its list; a run or item written on its
    // own carries it as `start` so a split list keeps counting.
    if (block.type === 'numberedListItem') {
      number = previous?.type === 'numberedListItem' ? number + 1 : Number(block.props?.start) || 1
      if (number !== 1 && (!run.length || !nestsCleanly(block))) block = { ...block, props: { ...block.props, start: number } }
    }
    previous = block
    if (block.type === 'toggleListItem' && underListItem) block = { ...block, type: 'bulletListItem' }

    if (block.type === 'toggleListItem' && editor.blocksToHTMLLossy) {
      flush()
      const html = editor.blocksToHTMLLossy([{ type: 'paragraph', content: block.content } as Block])
      const summary = escapeSummaryDollars(html.replace(/^\s*<p[^>]*>([\s\S]*)<\/p>\s*$/, '$1'))
      const body = block.children?.length ? `${serializeBlocks(editor, block.children, false)}\n\n` : ''
      parts.push(`<details>\n<summary>${summary}</summary>\n\n${body}</details>`)
      continue
    }
    if (nestsCleanly(block)) {
      run.push(block)
      continue
    }
    if (!LIST_ITEMS.has(block.type!)) {
      // Markdown cannot nest under a paragraph, heading or quote: its children
      // follow it as siblings (the WYSIWYG snapshot keeps the indentation in-app).
      run.push({ ...block, children: [] })
      queue.unshift(...block.children!)
      previous = undefined
      continue
    }
    flush()
    const item = write([{ ...block, children: [] }])
    /* Children sit at the item's content column. A checklist's is past the
       checkbox (`- [x] `): BlockNote's parser reads no shallower child there,
       although CommonMark renderers take 6 spaces as an indented code block. */
    const width = block.type === 'numberedListItem' ? `${number}. `.length : block.type === 'checkListItem' ? 6 : 2
    parts.push(`${item}\n\n${indent(serializeBlocks(editor, block.children!, true), width)}`)
  }
  flush()
  return parts.filter(Boolean).join('\n\n')
}

/** Empty markdown is valid output; only exceptions mean serialization failed.
 *  Text is escaped first (BlockNote writes it verbatim, see markdownEscape), so
 *  what the editor showed is what reloads; nesting BlockNote would flatten and
 *  toggles are laid out by `serializeBlocks`. BlockNote writes bullets as `* `
 *  and dividers as `***`; they are normalized to `- ` and `---` in prose only —
 *  inside a fence the same characters are code (a JSDoc ` * ` line). */
export function serializeMarkdown<Block>(editor: MarkdownEditor<Block>): string | null {
  try {
    const markdown = serializeBlocks(editor, editor.document as AnyBlock[], false)
      .trim()
      .replace(/^\n+/, '')
      .replace(/\n+$/, '')
    return mapProse(markdown, prose => prose.replace(/^(\s*)\* /gm, '$1- ').replace(/^(\s*)\*\*\*$/gm, '$1---'))
  } catch {
    return null
  }
}
