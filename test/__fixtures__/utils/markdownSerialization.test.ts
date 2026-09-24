import { describe, expect, it } from 'vitest'
import { serializeMarkdown } from '../../../frontend/utils/markdownSerialization'

describe('serializeMarkdown', () => {
  it('returns empty markdown as valid output', () => {
    const editor = { document: [], blocksToMarkdownLossy: () => '' }

    expect(serializeMarkdown(editor)).toBe('')
  })

  it('returns null when BlockNote serialization fails', () => {
    const editor = { document: [], blocksToMarkdownLossy: () => { throw new Error('failed') } }

    expect(serializeMarkdown(editor)).toBeNull()
  })
})
