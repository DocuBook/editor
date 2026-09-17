/** Markdown tokenizer for the raw (code) editor.
 *
 *  Tokens come from micromark — the CommonMark + GFM + frontmatter tokenizer
 *  that `mdast-util-from-markdown` is itself built on. Its event stream carries
 *  a token for every syntax character the Markdown AST drops
 *  (`atxHeadingSequence`, `blockQuoteMarker`, `listItemMarker`,
 *  `tableCellDivider`, `strongSequence`, fences, escapes, task boxes …), each
 *  with source offsets. So the work here is a token-type → colour table, not a
 *  second parser: no per-construct regular expressions, no marker
 *  reconstruction.
 *
 *  Only what the tokenizer cannot know stays local:
 *
 *  1. `yamlValue` lines — YAML's `key: value` split (micromark reports the raw
 *     line, not the pair).
 *  2. `inlineOverlay()` — the app's own dialect, which no Markdown tokenizer
 *     has: `[[wikilinks]]` and `$math$`.
 *
 *  LOSSLESS contract: every token text is a slice of the source, and the tokens
 *  cover it contiguously, so `markdownTokenText` reproduces the source
 *  byte-for-byte. The raw editor paints these behind a transparent <textarea>;
 *  a dropped or added character would shift the caret off the glyph being
 *  edited. Every emitted span is therefore clamped to the cursor and the gap
 *  between siblings is filled with plain text.
 */

import { parse, postprocess, preprocess } from 'micromark'
import { gfm } from 'micromark-extension-gfm'
import { frontmatter } from 'micromark-extension-frontmatter'

export type MarkdownTokenKind =
  | 'plain'
  | 'marker'
  | 'heading'
  | 'quote'
  | 'listMarker'
  | 'taskMarker'
  | 'code'
  | 'codeSpan'
  | 'codeFence'
  | 'codeLang'
  | 'frontmatterKey'
  | 'frontmatterValue'
  | 'tablePipe'
  | 'tableSeparator'
  | 'strong'
  | 'emphasis'
  | 'strike'
  | 'escape'
  | 'html'
  | 'link'
  | 'linkUrl'
  | 'wikilink'
  | 'math'
  | 'hr'

export interface MarkdownToken {
  kind: MarkdownTokenKind
  /** Leaf text. Unset on container tokens. */
  text?: string
  children?: MarkdownToken[]
}

/** CSS class per kind — colour only; layout stays owned by index.css. */
const CLASS_BY_KIND: Record<MarkdownTokenKind, string> = {
  plain: '',
  marker: 'md-marker',
  heading: 'md-heading',
  quote: 'md-quote',
  listMarker: 'md-list-marker',
  taskMarker: 'md-task-marker',
  code: 'md-code',
  codeSpan: 'md-code-span',
  codeFence: 'md-code-fence',
  codeLang: 'md-code-lang',
  frontmatterKey: 'md-frontmatter-key',
  frontmatterValue: 'md-frontmatter-value',
  tablePipe: 'md-table-pipe',
  tableSeparator: 'md-table-separator',
  strong: 'md-strong',
  emphasis: 'md-emphasis',
  strike: 'md-strike',
  escape: 'md-escape',
  html: 'md-html',
  link: 'md-link',
  linkUrl: 'md-link-url',
  wikilink: 'md-wikilink',
  math: 'md-math',
  hr: 'md-hr',
}

export function markdownTokenClass(kind: MarkdownTokenKind): string {
  return CLASS_BY_KIND[kind]
}

/** Leaf concatenation — the invariant the raw editor's overlay depends on. */
export function markdownTokenText(tokens: MarkdownToken[]): string {
  let out = ''
  for (const token of tokens) out += token.children ? markdownTokenText(token.children) : token.text ?? ''
  return out
}

/** GFM (tables, task lists, strikethrough, autolinks) plus YAML frontmatter. */
const PARSE_OPTIONS = { extensions: [gfm(), frontmatter(['yaml'])] }

/** The slice of micromark's token shape we consume. */
interface MicromarkToken {
  type: string
  start?: { offset?: number } | null
  end?: { offset?: number } | null
}

type MicromarkEvent = ['enter' | 'exit', MicromarkToken]

interface Span {
  start: number
  end: number
}

/** Token with its children nested, positions taken from the event stream. */
interface Node extends Span {
  type: string
  children: Node[]
}

/** Container tokens: the kind colours the whole subtree. */
const CONTAINER_KINDS: Partial<Record<string, MarkdownTokenKind>> = {
  atxHeading: 'heading',
  setextHeading: 'heading',
  blockQuote: 'quote',
  strong: 'strong',
  emphasis: 'emphasis',
  strikethrough: 'strike',
  link: 'link',
  image: 'link',
  codeFencedFence: 'codeFence',
  tableDelimiterRow: 'tableSeparator',
}

/** Leaf tokens that colour their whole span, children included. */
const LEAF_KINDS: Partial<Record<string, MarkdownTokenKind>> = {
  taskListCheck: 'taskMarker',
  characterEscape: 'escape',
  characterReference: 'escape',
  hardBreakEscape: 'escape',
  hardBreakTrailing: 'marker',
  htmlFlow: 'html',
  htmlText: 'html',
  htmlFlowData: 'html',
  htmlTextData: 'html',
  autolinkProtocol: 'linkUrl',
  literalAutolink: 'linkUrl',
  literalAutolinkHttp: 'linkUrl',
  literalAutolinkWww: 'linkUrl',
  literalAutolinkEmail: 'linkUrl',
  resourceDestinationString: 'linkUrl',
  definitionDestinationString: 'linkUrl',
  codeFencedFenceInfo: 'codeLang',
  codeTextData: 'codeSpan',
  codeIndented: 'code',
}

/** Plain leaf tokens: pure syntax, punctuation or a literal run of text. */
const LEAF_TEXT_KINDS: Partial<Record<string, MarkdownTokenKind>> = {
  atxHeadingSequence: 'marker',
  setextHeadingLineSequence: 'marker',
  blockQuoteMarker: 'marker',
  escapeMarker: 'marker',
  labelMarker: 'marker',
  labelImageMarker: 'marker',
  resourceMarker: 'marker',
  resourceTitleMarker: 'marker',
  definitionLabelMarker: 'marker',
  definitionMarker: 'marker',
  definitionTitleMarker: 'marker',
  autolinkMarker: 'marker',
  strongSequence: 'marker',
  emphasisSequence: 'marker',
  strikethroughSequence: 'marker',
  codeTextSequence: 'marker',
  codeFencedFenceSequence: 'marker',
  yamlFenceSequence: 'marker',
  listItemMarker: 'listMarker',
  listItemValue: 'listMarker',
  tableCellDivider: 'tablePipe',
  tableDelimiterFiller: 'tableSeparator',
  tableDelimiterMarker: 'tableSeparator',
  thematicBreakSequence: 'hr',
}

/** Nest micromark's event stream into a tree of source spans. */
function buildTree(source: string, events: MicromarkEvent[]): Node {
  const root: Node = { type: 'root', start: 0, end: source.length, children: [] }
  const stack: Node[] = [root]
  for (const [kind, token] of events) {
    if (kind === 'enter') {
      const node: Node = {
        type: token.type,
        start: token.start?.offset ?? 0,
        end: token.end?.offset ?? 0,
        children: [],
      }
      stack[stack.length - 1].children.push(node)
      stack.push(node)
      continue
    }
    const node = stack.pop()
    if (node) node.end = token.end?.offset ?? node.start
  }
  return root
}

class EventTokenizer {
  private readonly src: string

  constructor(src: string) {
    this.src = src
  }

  slice(start: number, end: number): string {
    return this.src.slice(start, end)
  }

  private leaf(kind: MarkdownTokenKind, start: number, end: number): MarkdownToken | null {
    return end > start ? { kind, text: this.slice(start, end) } : null
  }

  private push(target: MarkdownToken[], token: MarkdownToken | null) {
    if (token) target.push(token)
  }

  emitDocument(): MarkdownToken[] {
    const parser = parse(PARSE_OPTIONS)
    const events = postprocess(parser.document().write(preprocess()(this.src, undefined, true))) as unknown as MicromarkEvent[]
    return this.emitChildren(buildTree(this.src, events))
  }

  /** Children in source order, with the text between them filled as plain. */
  private emitChildren(node: Node, from = node.start): MarkdownToken[] {
    const tokens: MarkdownToken[] = []
    const children = node.children
    let cursor = from
    let index = 0
    while (index < children.length) {
      const child = children[index]
      if (child.end <= cursor) {
        index++
        continue
      }
      if (child.start > cursor) tokens.push(...this.overlay(cursor, child.start))

      // A construct that fails to open leaves several adjacent `data` tokens:
      // `[[Wiki Note]]` arrives as `[` + `[` + `Wiki Note]]`. Overlaying the run
      // instead of each token is what lets the app dialect see its full text.
      if (child.type === 'data') {
        let runEnd = child.end
        let next = children[index + 1]
        while (next && next.type === 'data' && next.start === runEnd) {
          runEnd = next.end
          index++
          next = children[index + 1]
        }
        tokens.push(...this.overlay(Math.max(child.start, cursor), runEnd))
        cursor = Math.max(cursor, runEnd)
        index++
        continue
      }

      tokens.push(...this.emit(child, cursor))
      cursor = Math.max(cursor, child.end)
      index++
    }
    if (cursor < node.end) tokens.push(...this.overlay(cursor, node.end))
    return tokens
  }

  /** A node, clamped to `from` so a stray overlap can never duplicate text. */
  private emit(node: Node, from: number): MarkdownToken[] {
    const start = Math.max(node.start, from)
    if (node.end <= start) return []

    const leafKind = LEAF_KINDS[node.type]
    if (leafKind) return [this.leaf(leafKind, start, node.end)!]

    if (node.type === 'data') return this.overlay(start, node.end)
    if (node.type === 'yamlValue') return this.yamlValueTokens(start, node.end)
    if (node.type === 'codeFenced') return this.codeBlockTokens(node, start)
    if (node.type === 'codeFlowValue') return [this.leaf('code', start, node.end)!]

    const container = CONTAINER_KINDS[node.type]
    if (container) return [{ kind: container, children: this.emitChildren(node, start) }]

    if (node.children.length) return this.emitChildren(node, start)

    return [this.leaf(LEAF_TEXT_KINDS[node.type] ?? 'plain', start, node.end)!]
  }

  /** Fenced code: fences and info string from tokens, each body line coloured
   *  with its line ending, so a line never splits across two tokens.
   *
   *  Children are walked with a cursor. Inside a container (`> ``` `, an indented
   *  fence in a list item) micromark's `lineEnding` spans the newline *and* the
   *  next line's container prefix, which the container's own tokens cover too;
   *  emitting both would duplicate that prefix and shift every later glyph. */
  private codeBlockTokens(node: Node, from: number): MarkdownToken[] {
    const tokens: MarkdownToken[] = []
    const children = node.children
    let cursor = from
    for (let index = 0; index < children.length; index++) {
      const child = children[index]
      if (child.end <= cursor) continue
      if (child.type !== 'codeFlowValue') {
        this.push(tokens, this.leaf('plain', cursor, child.start))
        tokens.push(...this.emit(child, cursor))
        cursor = Math.max(cursor, child.end)
        continue
      }
      const next = children[index + 1]
      const end = next && next.type === 'lineEnding' ? next.end : child.end
      this.push(tokens, this.leaf('code', cursor, Math.max(end, cursor)))
      cursor = Math.max(cursor, end)
      if (next && next.type === 'lineEnding') index++
    }
    return tokens
  }

  /** YAML frontmatter line: `# comment`, `key: value`, or a bare value. */
  private yamlValueTokens(start: number, end: number): MarkdownToken[] {
    const line = this.slice(start, end)
    if (line.trimStart().startsWith('#')) return [this.leaf('marker', start, end)!]
    // A colon inside a URL is not a key separator: a bare `- https://a.test`
    // line is all value, and splitting it would colour `https` as a key.
    const colon = line.indexOf(':')
    if (colon === -1 || line.slice(colon).startsWith('://')) return [this.leaf('frontmatterValue', start, end)!]
    return [
      this.leaf('frontmatterKey', start, start + colon),
      this.leaf('marker', start + colon, start + colon + 1),
      this.leaf('frontmatterValue', start + colon + 1, end),
    ].filter((token): token is MarkdownToken => token !== null)
  }

  /** App-specific inline syntax no Markdown tokenizer knows: `[[wiki]]` and
   *  `$math$`. Escapes are already tokens, so a `\$` never reaches here.
   *  Everything between them stays plain. */
  private overlay(start: number, end: number): MarkdownToken[] {
    const value = this.slice(start, end)
    const tokens: MarkdownToken[] = []
    let plainStart = start
    let i = 0

    const flush = (plainEnd: number) => {
      this.push(tokens, this.leaf('plain', plainStart, plainEnd))
    }

    while (i < end - start) {
      const char = value.charAt(i)

      if (char === '[' && value.charAt(i + 1) === '[') {
        const close = value.indexOf(']]', i + 2)
        if (close > i + 2) {
          flush(start + i)
          this.push(tokens, this.leaf('wikilink', start + i, start + close + 2))
          i = close + 2
          plainStart = start + i
          continue
        }
      }

      if (char === '$') {
        const run = Math.min(this.runLength(value, i, '$'), 2)
        const delim = '$'.repeat(run)
        const close = value.indexOf(delim, i + delim.length)
        if (close !== -1) {
          const inner = value.slice(i + delim.length, close)
          if (inner.trim() === inner && inner.length && !inner.includes('\n')) {
            flush(start + i)
            this.push(tokens, this.leaf('math', start + i, start + close + delim.length))
            i = close + delim.length
            plainStart = start + i
            continue
          }
        }
      }

      i++
    }

    flush(end)
    return tokens
  }

  private runLength(value: string, from: number, char: string): number {
    let length = 0
    while (value.charAt(from + length) === char) length++
    return length
  }
}

/** Tokenize raw markdown into a lossless, nestable token tree. */
export function highlightMarkdown(source: string): MarkdownToken[] {
  return new EventTokenizer(source).emitDocument()
}
