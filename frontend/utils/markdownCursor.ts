import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table'
import { gfm } from 'micromark-extension-gfm'

interface CursorBlock {
  id: string
  content?: unknown
  children?: CursorBlock[]
}

interface CursorEditor {
  document: CursorBlock[]
}

interface MarkdownNode {
  type: string
  value?: string
  alt?: string
  children?: MarkdownNode[]
  position?: {
    start: { offset?: number }
    end: { offset?: number }
  }
}

interface SourceCharacter {
  value: string
  offset: number
}

/** A visible character paired with its source offset, or `null` when the
 *  WYSIWYG inserted a character the Markdown has no glyph for — a quote's
 *  paragraph break, for example. The raw caret counts those characters too, so
 *  keeping them as null slots stops the two sides drifting apart. */
type AlignedCharacter = SourceCharacter | null

interface SourceBlock {
  start: number
  end: number
  characters: SourceCharacter[]
  children: SourceBlock[]
}

interface MappedBlock {
  block: CursorBlock
  source: SourceBlock
  children: MappedBlock[]
}

export interface MarkdownCursorPosition {
  block: CursorBlock
  textOffset: number
}

/** Inline text of a BlockNote content value, Markdown syntax excluded. */
function inlineText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(item => {
    if (typeof item === 'string') return item
    if (!item || typeof item !== 'object') return ''
    const value = item as { type?: string; text?: string; content?: unknown[] }
    if (value.type === 'text') return value.text ?? ''
    if (value.type === 'link' && Array.isArray(value.content)) {
      return value.content.map(child => typeof child === 'object' && child !== null && 'text' in child ? String(child.text ?? '') : '').join('')
    }
    return value.text ?? ''
  }).join('')
}

interface TableContent {
  type: 'tableContent'
  rows: { cells: unknown[] }[]
}

function isTableContent(content: unknown): content is TableContent {
  return !!content && typeof content === 'object' && !Array.isArray(content) && (content as { type?: string }).type === 'tableContent'
}

/** A table cell is either inline content or a `{ content }` wrapper. */
function cellContent(cell: unknown): unknown {
  return cell && typeof cell === 'object' && 'content' in cell ? (cell as { content: unknown }).content : cell
}

/** Visible text used to align a BlockNote cursor with Markdown AST text nodes.
 *
 *  A table is ONE BlockNote block holding every cell, while the tokenizer emits
 *  cell text in document order, so cells concatenate row by row. Pipes,
 *  delimiters and the header rule are syntax: they carry no visible character
 *  and must not enter the alignment. */
export function blockText(block: CursorBlock): string {
  const content = block.content
  if (isTableContent(content)) {
    return (content.rows ?? [])
      .map(row => (row.cells ?? []).map(cell => inlineText(cellContent(cell))).join(''))
      .join('')
  }
  return inlineText(content)
}

const nodeStart = (node: MarkdownNode) => node.position?.start.offset ?? 0
const nodeEnd = (node: MarkdownNode) => node.position?.end.offset ?? nodeStart(node)

/** Source positions for each UTF-16 code unit in an AST text value. */
function valueCharacters(markdown: string, node: MarkdownNode, value: string): SourceCharacter[] {
  const characters: SourceCharacter[] = []
  const end = nodeEnd(node)
  let searchFrom = nodeStart(node)
  for (let index = 0; index < value.length; index++) {
    let offset = markdown.indexOf(value[index], searchFrom)
    if (offset < 0 || offset >= end) offset = Math.min(searchFrom, Math.max(nodeStart(node), end - 1))
    characters.push({ value: value[index], offset })
    searchFrom = offset + 1
  }
  return characters
}

function textCharacters(markdown: string, node: MarkdownNode): SourceCharacter[] {
  if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') {
    return valueCharacters(markdown, node, node.value ?? '')
  }
  if (node.type === 'image') return valueCharacters(markdown, node, node.alt ?? '')
  if (node.type === 'break') return [{ value: '\n', offset: Math.max(nodeStart(node), nodeEnd(node) - 1) }]
  /* A list item owns only its first line; the continuation is a BlockNote child
     block of its own and must not leak into the item's own alignment. */
  if (node.type === 'listItem') {
    const own = listItemContent(node)
    return own ? listItemParts(markdown, own).first : []
  }
  return (node.children ?? []).flatMap(child => child.type === 'list' ? [] : textCharacters(markdown, child))
}

/** A list item's own block: its first paragraph-like child, before any sublist. */
function listItemContent(node: MarkdownNode): MarkdownNode | undefined {
  return (node.children ?? []).find(child => child.type !== 'list')
}

/** A list item's own Markdown block may hold soft or hard line breaks that
 *  BlockNote splits into the item's own inline content plus a nested paragraph
 *  holding the continuation lines. The item's alignment must stop at the first
 *  break and the rest becomes a child source block, or every caret in the item
 *  maps into the continuation (and the continuation maps to offset 0).
 *
 *  The split is found from the source newline, not from an AST text value:
 *  CommonMark drops the soft break when inline markup follows (`- a\n  **b**`).
 *
 *  Not modelled, because BlockNote's parser does not nest them either: a
 *  continuation line indented less than the item's content (`- a\nb`), a sublist
 *  at the same indent (`- a\n  b\n  - c`), and a task continuation
 *  (`- [ ] a\n  b`). BlockNote hoists those to top-level blocks; mirroring that
 *  would mean re-implementing its line grouping, and its serializer flattens a
 *  nested paragraph to an unindented top-level one on the way back out. */
function listItemParts(markdown: string, own: MarkdownNode): { first: SourceCharacter[]; continuation?: SourceBlock } {
  const characters = textCharacters(markdown, own)
  const newline = markdown.indexOf('\n', nodeStart(own))
  if (newline < 0 || newline >= nodeEnd(own)) return { first: characters }
  const first = characters.filter(character => character.offset < newline)
  const rest = characters.filter(character => character.offset > newline)
  if (!rest.length) return { first }
  return {
    first,
    continuation: { start: rest[0].offset, end: rest[rest.length - 1].offset + 1, characters: rest, children: [] },
  }
}

/** Child blocks of a container that BlockNote models as nested blocks: a list
 *  item's continuation paragraph and its sublists, in source order. */
function childBlocks(markdown: string, node: MarkdownNode): SourceBlock[] {
  if (node.type !== 'listItem') return []
  const children = node.children ?? []
  const ownIndex = children.findIndex(child => child.type !== 'list')
  const own = ownIndex < 0 ? undefined : children[ownIndex]
  const rest = ownIndex < 0 ? children : children.slice(ownIndex + 1)
  const blocks = rest.flatMap(child => child.type === 'list'
    ? sourceBlocks(markdown, child.children ?? [])
    : [sourceBlock(markdown, child)])
  const continuation = own ? listItemParts(markdown, own).continuation : undefined
  return continuation ? [continuation, ...blocks] : blocks
}

function sourceBlock(markdown: string, node: MarkdownNode): SourceBlock {
  return {
    start: nodeStart(node),
    end: nodeEnd(node),
    characters: textCharacters(markdown, node),
    children: childBlocks(markdown, node),
  }
}

/** Lists are AST containers; BlockNote blocks correspond to their list items.
 *  A GFM table is the reverse: one BlockNote block holds every cell while the
 *  tokenizer emits cell text in document order, which is exactly what the
 *  generic walk below concatenates — so `mdast-util-gfm-table` turns a table
 *  into a single source block with no span special case, and the parse stays on
 *  one pass. */
function sourceBlocks(markdown: string, nodes: MarkdownNode[]): SourceBlock[] {
  return nodes.flatMap(node => node.type === 'list'
    ? sourceBlocks(markdown, node.children ?? [])
    : [sourceBlock(markdown, node)])
}

function emptySource(offset: number): SourceBlock {
  return { start: offset, end: offset, characters: [], children: [] }
}

function mapBlocks(blocks: CursorBlock[], sources: SourceBlock[], fallbackOffset = 0): MappedBlock[] {
  return blocks.map((block, index) => {
    const source = sources[index] ?? emptySource(sources[index - 1]?.end ?? fallbackOffset)
    return {
      block,
      source,
      children: mapBlocks(block.children ?? [], source.children, source.start),
    }
  })
}

function mappedDocument(editor: CursorEditor, markdown: string): MappedBlock[] {
  return mapBlocks(editor.document, sourceBlocksFor(markdown))
}

/** Source blocks for a Markdown string. The parse is the expensive half of a
 *  mapping and depends only on the Markdown — never on the editor document — so
 *  one entry is cached: a single mode switch maps its caret against the same
 *  string that the dirty serialize already parsed, and a batch of carets costs
 *  one parse instead of one each. This is also why the cache cannot go stale
 *  against an edited document: `mapBlocks` re-runs on every call. */
let sourceCache: { markdown: string; sources: SourceBlock[] } | null = null

function sourceBlocksFor(markdown: string): SourceBlock[] {
  if (sourceCache?.markdown === markdown) return sourceCache.sources
  const root = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmTableFromMarkdown()] }) as MarkdownNode
  const sources = sourceBlocks(markdown, root.children ?? [])
  sourceCache = { markdown, sources }
  return sources
}

function findMappedBlock(blocks: MappedBlock[], id: string): MappedBlock | undefined {
  for (const block of blocks) {
    if (block.block.id === id) return block
    const child = findMappedBlock(block.children, id)
    if (child) return child
  }
  return undefined
}

/** Placeholder for a WYSIWYG-only break glyph: a paragraph/hard break, and the
 *  single space BlockNote keeps after it. Neither can match a source character,
 *  so keeping them as slots the greedy match skips stops a break from stealing a
 *  real source character and dragging the rest of the block off by one. */
const BREAK = '\u0000'
const BREAK_SPACE = '\u0001'

/** Visible text with break glyphs replaced by non-matching placeholders. The
 *  length is preserved, so caret offsets stay usable. */
function alignmentText(text: string): string {
  let out = ''
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '\n') {
      out += text[index]
      continue
    }
    out += BREAK
    if (text[index + 1] === ' ') {
      out += BREAK_SPACE
      index++
    }
  }
  return out
}

/** Align AST text with BlockNote inline content. Characters the Markdown side
 *  has no glyph for become null slots instead of consuming a source character,
 *  so a quote's paragraph break or a hard break never drags the rest of the
 *  block off by one. */
function alignedCharacters(mapped: MappedBlock): AlignedCharacter[] {
  const text = blockText(mapped.block)
  if (!text) return mapped.source.characters
  const visible = alignmentText(text)
  const aligned: AlignedCharacter[] = []
  let searchFrom = 0
  for (let index = 0; index < visible.length; index++) {
    const found = mapped.source.characters.findIndex((character, sourceIndex) => sourceIndex >= searchFrom && character.value === visible[index])
    if (found < 0) {
      aligned.push(null)
      continue
    }
    aligned.push(mapped.source.characters[found])
    searchFrom = found + 1
  }
  return aligned
}

/** Offset of the first source character at or after `index`. */
function offsetAt(characters: AlignedCharacter[], index: number): number | undefined {
  for (let cursor = Math.max(0, index); cursor < characters.length; cursor++) {
    const character = characters[cursor]
    if (character) return character.offset
  }
  return undefined
}

function contentStart(mapped: MappedBlock): number {
  return offsetAt(alignedCharacters(mapped), 0) ?? mapped.source.start
}

function sourceOffsetForTextOffset(mapped: MappedBlock, textOffset: number): number {
  const characters = alignedCharacters(mapped)
  if (!characters.length) return mapped.source.start
  if (textOffset <= 0) return offsetAt(characters, 0) ?? mapped.source.start
  if (textOffset >= characters.length) {
    const last = characters[characters.length - 1]
    /* Normal end of text: one past the last visible character. A trailing break
       artifact has no source glyph, so the raw caret belongs after the block's
       break syntax — the end of its source range. */
    if (last) return Math.min(mapped.source.end, last.offset + 1)
    return mapped.source.end
  }
  /* `offsetAt` finds nothing when the caret sits in trailing break artifacts;
     the raw caret then belongs at the end of the block, not at its start. */
  return offsetAt(characters, textOffset) ?? mapped.source.end
}

function textOffsetForSourceOffset(mapped: MappedBlock, sourceOffset: number): number {
  const characters = alignedCharacters(mapped)
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index]
    if (character && character.offset >= sourceOffset) return index
  }
  return characters.length
}

function blockAtOffset(blocks: MappedBlock[], offset: number): MappedBlock | undefined {
  let block: MappedBlock | undefined
  for (const candidate of blocks) {
    if (candidate.source.start > offset) break
    block = candidate
  }
  if (!block) return undefined
  if (offset <= block.source.end) return blockAtOffset(block.children, offset) ?? block
  return block
}

/** Source offset for a BlockNote block and UTF-16 text position inside it. */
export function markdownOffsetForCursor(
  editor: CursorEditor,
  markdown: string,
  blockId: string,
  textOffset: number,
): number {
  const mapped = findMappedBlock(mappedDocument(editor, markdown), blockId)
  if (!mapped) return 0
  return Math.min(markdown.length, sourceOffsetForTextOffset(mapped, textOffset))
}

/** Source offset at visible content start of a BlockNote block. */
export function markdownOffsetForBlock(editor: CursorEditor, markdown: string, blockId: string): number {
  const mapped = findMappedBlock(mappedDocument(editor, markdown), blockId)
  return mapped ? Math.min(markdown.length, contentStart(mapped)) : 0
}

/** Maps a source offset to its deepest BlockNote block and UTF-16 text offset. */
export function cursorPositionAtMarkdownOffset(
  editor: CursorEditor,
  markdown: string,
  offset: number,
): MarkdownCursorPosition | undefined {
  const document = mappedDocument(editor, markdown)
  const mapped = blockAtOffset(document, Math.max(0, Math.min(markdown.length, offset))) ?? document[0]
  if (!mapped) return undefined
  return {
    block: mapped.block,
    textOffset: textOffsetForSourceOffset(mapped, offset),
  }
}

/** Deepest BlockNote block containing a source offset. */
export function blockAtMarkdownOffset(editor: CursorEditor, markdown: string, offset: number): CursorBlock | undefined {
  return cursorPositionAtMarkdownOffset(editor, markdown, offset)?.block
}
