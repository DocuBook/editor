interface MarkdownEditor<Block> {
  document: Block[]
  blocksToMarkdownLossy: (blocks?: Block[]) => string
}

/** Empty markdown is valid output; only exceptions mean serialization failed. */
export function serializeMarkdown<Block>(editor: MarkdownEditor<Block>): string | null {
  try {
    return editor.blocksToMarkdownLossy(editor.document)
      .trim()
      .replace(/^\n+/, '')
      .replace(/\n+$/, '')
      .replace(/^(\s*)\* /gm, '$1- ')
  } catch {
    return null
  }
}
