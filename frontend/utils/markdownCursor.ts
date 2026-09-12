import { fromMarkdown } from 'mdast-util-from-markdown'

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

/** Visible text used to align a BlockNote cursor with Markdown AST text nodes. */
function blockText(block: CursorBlock): string {
  if (typeof block.content === 'string') return block.content
  if (!Array.isArray(block.content)) return ''
  return block.content.map(item => {
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
  return (node.children ?? []).flatMap(child => child.type === 'list' ? [] : textCharacters(markdown, child))
}

function sourceBlock(markdown: string, node: MarkdownNode): SourceBlock {
  return {
    start: nodeStart(node),
    end: nodeEnd(node),
    characters: textCharacters(markdown, node),
    children: node.type === 'listItem'
      ? (node.children ?? []).flatMap(child => child.type === 'list' ? sourceBlocks(markdown, child.children ?? []) : [])
      : [],
  }
}

/** Lists are AST containers; BlockNote blocks correspond to their list items. */
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
  const root = fromMarkdown(markdown) as MarkdownNode
  return mapBlocks(editor.document, sourceBlocks(markdown, root.children ?? []))
}

function findMappedBlock(blocks: MappedBlock[], id: string): MappedBlock | undefined {
  for (const block of blocks) {
    if (block.block.id === id) return block
    const child = findMappedBlock(block.children, id)
    if (child) return child
  }
  return undefined
}

/** Align AST text with BlockNote inline content without counting Markdown syntax. */
function alignedCharacters(mapped: MappedBlock): SourceCharacter[] {
  const visible = blockText(mapped.block)
  if (!visible) return mapped.source.characters
  const aligned: SourceCharacter[] = []
  let searchFrom = 0
  for (let index = 0; index < visible.length; index++) {
    let found = mapped.source.characters.findIndex((character, sourceIndex) => sourceIndex >= searchFrom && character.value === visible[index])
    if (found < 0) found = Math.min(searchFrom, mapped.source.characters.length - 1)
    if (found < 0) break
    aligned.push(mapped.source.characters[found])
    searchFrom = found + 1
  }
  return aligned
}

function contentStart(mapped: MappedBlock): number {
  return alignedCharacters(mapped)[0]?.offset ?? mapped.source.start
}

function sourceOffsetForTextOffset(mapped: MappedBlock, textOffset: number): number {
  const characters = alignedCharacters(mapped)
  if (!characters.length) return mapped.source.start
  if (textOffset <= 0) return characters[0].offset
  if (textOffset >= characters.length) return Math.min(mapped.source.end, characters[characters.length - 1].offset + 1)
  return characters[textOffset].offset
}

function textOffsetForSourceOffset(mapped: MappedBlock, sourceOffset: number): number {
  return alignedCharacters(mapped).filter(character => character.offset < sourceOffset).length
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
