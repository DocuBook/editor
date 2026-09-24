import { describe, it, expect } from 'vitest'
import { normalizeMarkdown } from '../../../frontend/utils/aiBlocks'

describe('normalizeMarkdown', () => {
  it('closes unbalanced code fence', () => {
    const out = normalizeMarkdown('text\n```js\nconsole.log(1)')
    expect((out.match(/```/g) || []).length % 2).toBe(0)
    expect(out.trim().endsWith('```')).toBe(true)
  })

  it('leaves balanced fences unchanged', () => {
    const md = '```js\nx\n```\nmore'
    expect(normalizeMarkdown(md)).toBe(md)
  })
})
