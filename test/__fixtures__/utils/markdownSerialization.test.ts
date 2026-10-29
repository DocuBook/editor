import { describe, expect, it } from 'vitest'
import { serializeMarkdown } from '../../../frontend/utils/markdownSerialization'

describe('serializeMarkdown', () => {
  it('returns empty markdown as valid output', () => {
    const editor = { document: [], blocksToMarkdownLossy: () => '' }

    expect(serializeMarkdown(editor)).toBe('')
  })

  it('returns null when BlockNote serialization fails', () => {
    const editor = { document: [{ type: 'paragraph' }], blocksToMarkdownLossy: () => { throw new Error('failed') } }

    expect(serializeMarkdown(editor)).toBeNull()
  })

  it('normalizes prose bullets to dashes', () => {
    const editor = { document: [{ type: 'paragraph' }], blocksToMarkdownLossy: () => '* a\n  * b\n' }

    expect(serializeMarkdown(editor)).toBe('- a\n  - b')
  })

  it('leaves `* ` lines inside fenced code alone (JSDoc)', () => {
    const md = '* a\n\n```ts\n/**\n * Adds\n * @param a\n */\n```\n\n* b'
    const editor = { document: [{ type: 'paragraph' }], blocksToMarkdownLossy: () => md }

    expect(serializeMarkdown(editor)).toBe('- a\n\n```ts\n/**\n * Adds\n * @param a\n */\n```\n\n- b')
  })
})
