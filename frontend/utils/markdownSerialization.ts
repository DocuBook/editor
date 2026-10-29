import { mapProse } from './markdownCode'
import { escapeBlocksForMarkdown } from './markdownEscape'

interface MarkdownEditor<Block> {
  document: Block[]
  blocksToMarkdownLossy: (blocks?: Block[]) => string
}

/** Empty markdown is valid output; only exceptions mean serialization failed.
 *  Text is escaped first (BlockNote writes it verbatim, see markdownEscape), so
 *  what the editor showed is what reloads. BlockNote writes bullets as `* `;
 *  they are normalized to `- ` in prose only — inside a fence the same
 *  characters are code (a JSDoc ` * ` line). */
export function serializeMarkdown<Block>(editor: MarkdownEditor<Block>): string | null {
  try {
    const markdown = editor.blocksToMarkdownLossy(escapeBlocksForMarkdown(editor.document))
      .trim()
      .replace(/^\n+/, '')
      .replace(/\n+$/, '')
    return mapProse(markdown, prose => prose.replace(/^(\s*)\* /gm, '$1- '))
  } catch {
    return null
  }
}
