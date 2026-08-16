import { describe, it, expect } from 'vitest'
import { mathDollarToMathML } from './mathMarkdown'

describe('mathDollarToMathML', () => {
  it('block $$ on own line', () => {
    const r = mathDollarToMathML('Before\n\n$$E = mc^2$$\n\nAfter')
    expect(r).toContain('<div><math display="block"><annotation encoding="application/x-tex">E = mc^2</annotation></math></div>')
    expect(r).not.toContain('$$')
  })

  it('inline $ within text', () => {
    const r = mathDollarToMathML('Text $x$ inline')
    expect(r).toContain('<math display="inline"><annotation encoding="application/x-tex">x</annotation></math>')
  })

  it('escaped \\$ is preserved', () => {
    const r = mathDollarToMathML('Price is \\$5 and $x$ math')
    expect(r).toContain('\\$5')
    expect(r).toContain('display="inline"')
  })

  it('multi-line block math', () => {
    const r = mathDollarToMathML('$$\nf(x) = x^2\n$$\n')
    expect(r).toContain('f(x) = x^2')
  })

  it('money amounts are not math', () => {
    const r = mathDollarToMathML('Cost: $5 and $10 total')
    expect(r).not.toContain('display=')
  })

  it('inline math with underscore not confused', () => {
    const r = mathDollarToMathML('Use $x_i$ here')
    expect(r).toContain('x_i')
  })
})
