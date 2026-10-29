import { describe, expect, it } from 'vitest'
import { mapProse, protectInlineCode, splitFencedCode } from '../../../frontend/utils/markdownCode'

describe('splitFencedCode', () => {
  const samples = [
    'plain\n\n```ts\nconst a = 1\n```\n\nafter',
    '~~~\ncode\n~~~',
    '````md\n```\nnested\n```\n````\ntail',
    '- item\n\n  ```sh\n  echo $(pwd)\n  ```\n',
    '> ```\n> quoted\n> ```',
    '```\nnever closed\n* still code',
    '',
  ]

  it.each(samples)('concatenates back to the input: %j', (md) => {
    expect(splitFencedCode(md).map(s => s.text).join('')).toBe(md)
  })

  it('marks fence lines and their content as code', () => {
    expect(splitFencedCode('a\n```\nx\n```\nb')).toEqual([
      { code: false, text: 'a\n' },
      { code: true, text: '```\nx\n```\n' },
      { code: false, text: 'b' },
    ])
  })

  it('closes only on the same fence character, at least as long', () => {
    const [, code] = splitFencedCode('a\n````\n```\n~~~~\n````\nb')
    expect(code).toEqual({ code: true, text: '````\n```\n~~~~\n````\n' })
  })

  it('treats an unclosed fence as code to the end', () => {
    expect(splitFencedCode('```\n * x')).toEqual([{ code: true, text: '```\n * x' }])
  })

  it('maps prose only', () => {
    expect(mapProse('* a\n```\n* b\n```\n* c', p => p.replace(/\* /g, '- '))).toBe('- a\n```\n* b\n```\n- c')
  })
})

describe('protectInlineCode', () => {
  const run = (md: string) => protectInlineCode(md, i => `<${i}>`)

  it('replaces matched spans and returns them', () => {
    expect(run('a `x` b ``y ` z`` c')).toEqual({ text: 'a <0> b <1> c', spans: ['`x`', '``y ` z``'] })
  })

  it('leaves an unmatched or escaped backtick as text', () => {
    expect(run('a ` b')).toEqual({ text: 'a ` b', spans: [] })
    expect(run('a \\`b` c')).toEqual({ text: 'a \\`b` c', spans: [] })
  })

  it('does not join backticks across a paragraph break', () => {
    expect(run('a `b\n\nc` d')).toEqual({ text: 'a `b\n\nc` d', spans: [] })
  })
})
