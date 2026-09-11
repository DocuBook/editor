interface CursorBlock {
  id: string
  children?: CursorBlock[]
}

interface CursorEditor {
  document: CursorBlock[]
  blocksToMarkdownLossy: (blocks: any[]) => string
}

export interface MarkdownCursorPosition {
  block: CursorBlock
  textOffset: number
}

const cleanMarkdown = (markdown: string) => markdown
  .trim()
  .replace(/^\n+/, '')
  .replace(/\n+$/, '')
  .replace(/^(\s*)\* /gm, '$1- ')

const containsBlock = (block: CursorBlock, id: string): boolean =>
  block.id === id || !!block.children?.some(child => containsBlock(child, id))

function findBlock(block: CursorBlock, id: string): CursorBlock | undefined {
  if (block.id === id) return block
  for (const child of block.children ?? []) {
    const found = findBlock(child, id)
    if (found) return found
  }
  return undefined
}

/** Visible text used to align a BlockNote cursor with its Markdown export. */
function blockText(block: CursorBlock & { content?: unknown }): string {
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

/** Source positions for visible characters, skipping Markdown syntax. */
function visibleCharacterPositions(source: string, visible: string): number[] {
  const positions: number[] = []
  let searchFrom = 0
  for (const character of visible) {
    const position = source.indexOf(character, searchFrom)
    if (position < 0) return positions
    positions.push(position)
    searchFrom = position + character.length
  }
  return positions
}

function sourceOffsetForTextOffset(source: string, visible: string, textOffset: number): number {
  if (!visible) return 0
  const positions = visibleCharacterPositions(source, visible)
  if (textOffset <= 0) return positions[0] ?? 0
  if (textOffset >= positions.length) return source.length
  return positions[textOffset - 1] + 1
}

function textOffsetForSourceOffset(source: string, visible: string, sourceOffset: number): number {
  const positions = visibleCharacterPositions(source, visible)
  return positions.filter(position => position < sourceOffset).length
}

function blockStarts(editor: CursorEditor, markdown: string): number[] {
  let searchFrom = 0
  return editor.document.map((block, index) => {
    const blockMarkdown = cleanMarkdown(editor.blocksToMarkdownLossy([block]))
    const found = blockMarkdown ? markdown.indexOf(blockMarkdown, searchFrom) : -1
    let start = found >= 0 ? found : cleanMarkdown(editor.blocksToMarkdownLossy(editor.document.slice(0, index))).length
    while (start < markdown.length && markdown[start] === '\n') start++
    start = Math.min(markdown.length, Math.max(index ? searchFrom : 0, start))
    searchFrom = start + blockMarkdown.length
    return start
  })
}

function blockIndexAtOffset(starts: number[], offset: number): number {
  let index = 0
  while (index + 1 < starts.length && starts[index + 1] <= offset) index++
  return index
}

/** Source offset for a BlockNote block and text position inside that block. */
export function markdownOffsetForCursor(
  editor: CursorEditor,
  markdown: string,
  blockId: string,
  textOffset: number,
): number {
  const index = editor.document.findIndex(block => containsBlock(block, blockId))
  if (index < 0) return 0
  const target = findBlock(editor.document[index], blockId) ?? editor.document[index]
  const start = blockStarts(editor, markdown)[index] ?? 0
  const source = cleanMarkdown(editor.blocksToMarkdownLossy([editor.document[index]]))
  return Math.min(markdown.length, start + sourceOffsetForTextOffset(source, blockText(target), textOffset))
}

/** Source offset at the start of a BlockNote block. */
export function markdownOffsetForBlock(editor: CursorEditor, markdown: string, blockId: string): number {
  return markdownOffsetForCursor(editor, markdown, blockId, 0)
}

/** Maps a source offset to its BlockNote block and visible text offset. */
export function cursorPositionAtMarkdownOffset(
  editor: CursorEditor,
  markdown: string,
  offset: number,
): MarkdownCursorPosition | undefined {
  if (editor.document.length === 0) return undefined
  const starts = blockStarts(editor, markdown)
  const index = blockIndexAtOffset(starts, Math.max(0, offset))
  const block = editor.document[index]
  if (!block) return undefined
  const source = cleanMarkdown(editor.blocksToMarkdownLossy([block]))
  const localOffset = Math.max(0, Math.min(source.length, offset - (starts[index] ?? 0)))
  return {
    block,
    textOffset: textOffsetForSourceOffset(source, blockText(block), localOffset),
  }
}

/** Top-level BlockNote block containing a source offset. */
export function blockAtMarkdownOffset(editor: CursorEditor, markdown: string, offset: number): CursorBlock | undefined {
  return cursorPositionAtMarkdownOffset(editor, markdown, offset)?.block
}
