import { describe, it, expect } from 'vitest'
import { findWikilinkAt } from './wikilink'

describe('findWikilinkAt', () => {
  it('finds the title at offset inside the link', () => {
    const text = 'see [[Hello World]] end'
    expect(findWikilinkAt(text, 8)).toBe('Hello World')
    expect(findWikilinkAt(text, 10)).toBe('Hello World')
  })
  it('is inclusive at both edges', () => {
    const text = 'a[[b]]c'
    expect(findWikilinkAt(text, 1)).toBe('b')  // opening bracket
    expect(findWikilinkAt(text, 5)).toBe('b')  // closing bracket
  })
  it('returns null outside links', () => {
    const text = 'a[[b]] c'
    expect(findWikilinkAt(text, 0)).toBeNull()
    expect(findWikilinkAt(text, 7)).toBeNull()  // past the link + space
    expect(findWikilinkAt(text, 10)).toBeNull() // beyond the string
  })
  it('handles multiple links independently', () => {
    const text = '[[One]] then [[Two]]'
    expect(findWikilinkAt(text, 3)).toBe('One')
    expect(findWikilinkAt(text, 14)).toBe('Two')
  })
  it('handles empty text', () => {
    expect(findWikilinkAt('', 0)).toBeNull()
  })
})