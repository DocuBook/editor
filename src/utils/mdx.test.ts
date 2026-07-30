import { describe, it, expect } from 'vitest'
import { extractMdxBlocks, restoreMdxBlocks } from '../utils/mdx'

describe('extractMdxBlocks', () => {
  it('replaces self-closing MDX Note tag', () => {
    const [out, map] = extractMdxBlocks('text <Note/>')
    expect(out).toContain('<<<MDX_')
    expect(out).toContain('>>>')
    expect(map.size).toBe(1)
  })

  it('replaces paired MDX tags', () => {
    const [out] = extractMdxBlocks('before <Note>content</Note> after')
    expect(out).toContain('<<<MDX_')
    expect(out).not.toContain('<Note>')
  })

  it('preserves non-MDX tags', () => {
    const [out] = extractMdxBlocks('<div>hello</div>')
    expect(out).toBe('<div>hello</div>')
  })

  it('preserves unknown uppercase tags', () => {
    const [out] = extractMdxBlocks('<Unknown>content</Unknown>')
    expect(out).toBe('<Unknown>content</Unknown>')
  })

  it('handles consecutive blocks', () => {
    const [, map] = extractMdxBlocks('<Note/>\n<CodeBlock lang="ts">code</CodeBlock>')
    expect(map.size).toBeGreaterThanOrEqual(2)
  })
})

describe('restoreMdxBlocks', () => {
  it('restores placeholders', () => {
    const map = new Map([['<<<MDX_0>>>', '<Note>text</Note>']])
    expect(restoreMdxBlocks('x <<<MDX_0>>> y', map)).toBe('x <Note>text</Note> y')
  })

  it('multiple restorations', () => {
    const map = new Map([
      ['<<<MDX_0>>>', '<Note/>'],
      ['<<<MDX_1>>>', '<Button />'],
    ])
    expect(restoreMdxBlocks('a <<<MDX_0>>> b <<<MDX_1>>> c', map)).toBe('a <Note/> b <Button /> c')
  })
})
