/**
 * Markdown escaping for text typed in the WYSIWYG editor.
 *
 * BlockNote's Markdown exporter writes text nodes verbatim, so a paragraph whose
 * text is `# x`, `1. x` or `---` reloads as a heading, a list or a divider, and
 * `*a*`, `` `a` ``, `<kbd>`, `[a](b)` or `$x$` reload as formatting, HTML, a
 * link or math. The editor showed literal characters, so the file must too.
 *
 * Raw HTML (`<kbd>`) cannot be escaped: BlockNote's parser honours no `\<`
 * and decodes no entities, so a typed tag still reloads as HTML.
 *
 * Escaping is minimal on purpose — the file is also read by people and git:
 * text that already reloads as itself (`2 * 3`, `snake_case`, `Paid $5`) is
 * left alone, and spans other tools parse from the raw text (`[[wikilinks]]`,
 * bare URLs, footnote references) are never touched.
 */
import { mathDollarToMathML } from './mathMarkdown'

/** Blocks whose inline text is Markdown prose. Code, math and diagram blocks
 *  hold literal source and are exported as-is. */
const PROSE_BLOCKS = new Set(['paragraph', 'heading', 'bulletListItem', 'numberedListItem', 'checkListItem', 'toggleListItem', 'quote', 'table'])

/** Blocks whose Markdown form is one line: an ATX heading cannot continue, and
 *  BlockNote neither indents a list item's continuation line nor parses one.
 *  A hard break inside them is written as `<br>`, which its parser reads back
 *  as the same break. Paragraphs and quotes keep Markdown's `\` + newline. */
const SINGLE_LINE_BLOCKS = new Set(['heading', 'bulletListItem', 'numberedListItem', 'checkListItem', 'toggleListItem'])

/** Spans copied through verbatim: wikilinks, footnote refs, bare URLs. */
const VERBATIM = /\[\[[^\]\n]+\]\]|\[\^[^\]\s]+\]|(?:https?:\/\/|www\.)[^\s<]+/g

/** Characters BlockNote's Markdown parser unescapes after a backslash — the
 *  only escapes that work; any other `\x` stays a literal backslash in the
 *  editor. `$` is added because the math load path (mathMarkdown) honours `\$`. */
const ESCAPABLE = '\\`*_{}[]()#+-.!~|>$'

const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch)
const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch)

/** Escape inline syntax in one stretch of text with no verbatim spans in it.
 *  A run edge counts as an unknown neighbour, so a delimiter there is escaped.
 *  `dollars`: also escape every `$` (the run holds a pair the load path would
 *  read as math). A backslash before it is already doubled above, so `\$` here
 *  always escapes the dollar itself. */
function escapeInline(text: string, dollars: boolean): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const prev = text[i - 1]
    const next = text[i + 1]
    if (ch === '\\' && next !== undefined && ESCAPABLE.includes(next)) out += '\\\\'
    // `*` with whitespace on both sides can neither open nor close emphasis.
    else if (ch === '*' && !(i > 0 && isSpace(prev) && i < text.length - 1 && isSpace(next))) out += '\\*'
    // Intraword `_` never forms emphasis (`snake_case`); a spaced one cannot either.
    else if (ch === '_' && !((isWord(prev) && isWord(next)) || (i > 0 && isSpace(prev) && i < text.length - 1 && isSpace(next)))) out += '\\_'
    else if (ch === '`') out += '\\`'
    else if (ch === '~' && (prev === '~' || next === '~')) out += '\\~'
    else if (ch === '[' && /^\[[^\]\n]*\]\(/.test(text.slice(i))) out += '\\['
    else if (ch === '$' && dollars) out += '\\$'
    else out += ch
  }
  return out
}

/** Block syntax a line of text could start: ATX heading, quote, list marker,
 *  ordered marker, thematic break / `-` setext underline. A `=` underline has
 *  no escape BlockNote honours, so it is left as is. */
function escapeLineStart(line: string): string {
  const lead = /^[ \t]*/.exec(line)![0]
  const rest = line.slice(lead.length)
  if (/^(?:#{1,6}(?=\s|$)|>|[-+](?=\s|$))/.test(rest)) return `${lead}\\${rest}`
  const ordered = /^(\d{1,9})([.)])(?=\s|$)/.exec(rest)
  if (ordered) return `${lead}${ordered[1]}\\${rest.slice(ordered[1].length)}`
  if (/^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(rest) || /^-+[ \t]*$/.test(rest)) return `${lead}\\${rest}`
  return line
}

/** Escape one text run. `lineStart`: the run begins a line, so block syntax at
 *  its start (and after every newline in it) must be escaped too. */
export function escapeMarkdownText(text: string, lineStart: boolean): string {
  const escapeRuns = (dollars: boolean) => {
    let out = ''
    let last = 0
    for (const match of text.matchAll(VERBATIM)) {
      out += escapeInline(text.slice(last, match.index), dollars) + match[0]
      last = match.index! + match[0].length
    }
    return out + escapeInline(text.slice(last), dollars)
  }
  // A `$` pair the load path would read as math is escaped as a whole; lone
  // dollars (prices) reload as themselves and stay readable.
  let escaped = escapeRuns(false)
  if (mathDollarToMathML(escaped) !== escaped) escaped = escapeRuns(true)
  return escaped
    .split('\n')
    .map((line, i) => (i > 0 || lineStart ? escapeLineStart(line) : line))
    .join('\n')
}

type Inline = { type: string; text?: string; styles?: Record<string, unknown>; content?: unknown }

function escapeInlineContent(items: unknown, lineStarts: boolean, htmlBreaks = false): unknown {
  if (!Array.isArray(items)) return items
  let atLineStart = lineStarts
  return items.flatMap((item: Inline) => {
    if (item?.type === 'text' && typeof item.text === 'string') {
      // `<br>` inside a code span is literal text, so the span is split at each
      // break and the `<br>` written between the pieces.
      if (htmlBreaks && item.styles?.code && item.text.includes('\n')) {
        atLineStart = false
        return item.text.split('\n').flatMap((part, i) => [
          ...(i ? [{ type: 'text', text: '<br>', styles: {} }] : []),
          ...(part ? [{ ...item, text: part }] : []),
        ])
      }
      let text = item.styles?.code ? item.text : escapeMarkdownText(item.text, atLineStart)
      if (htmlBreaks) text = text.split('\n').join('<br>')
      atLineStart = lineStarts && !htmlBreaks && item.text.endsWith('\n')
      return text === item.text ? item : { ...item, text }
    }
    atLineStart = false
    if (item?.type === 'link') return { ...item, content: escapeInlineContent(item.content, false, htmlBreaks) }
    return item
  })
}

function escapeTableContent(content: any): unknown {
  if (content?.type !== 'tableContent' || !Array.isArray(content.rows)) return content
  return {
    ...content,
    rows: content.rows.map((row: any) => ({
      ...row,
      cells: (row.cells ?? []).map((cell: any) => (Array.isArray(cell)
        ? escapeInlineContent(cell, false)
        : { ...cell, content: escapeInlineContent(cell?.content, false) })),
    })),
  }
}

/** A copy of `blocks` whose prose text is escaped for Markdown export. The
 *  editor's document is never modified. */
export function escapeBlocksForMarkdown<Block>(blocks: Block[]): Block[] {
  return blocks.map((block: any) => {
    const children = Array.isArray(block?.children) && block.children.length ? escapeBlocksForMarkdown(block.children) : block?.children
    if (!PROSE_BLOCKS.has(block?.type)) return children === block?.children ? block : { ...block, children }
    const content = block.type === 'table'
      ? escapeTableContent(block.content)
      : escapeInlineContent(block.content, true, SINGLE_LINE_BLOCKS.has(block.type))
    return { ...block, content, children }
  })
}
