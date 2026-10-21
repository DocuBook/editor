import { describe, it, expect } from 'vitest'
import { findWikilinkAt, isVaultLinkUrl, resolveVaultLinkTarget } from '../../../frontend/utils/wikilink'

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

describe('isVaultLinkUrl', () => {
  it('treats scheme-less targets as vault links', () => {
    expect(isVaultLinkUrl('note.md')).toBe(true)
    expect(isVaultLinkUrl('notes/idea.md')).toBe(true)
    expect(isVaultLinkUrl('./a.md')).toBe(true)
    expect(isVaultLinkUrl('../a.md')).toBe(true)
    expect(isVaultLinkUrl('/a.md')).toBe(true)
    expect(isVaultLinkUrl('#anchor')).toBe(true)
  })

  it('leaves web and app URLs to the external opener', () => {
    expect(isVaultLinkUrl('https://example.com')).toBe(false)
    expect(isVaultLinkUrl('mailto:a@b.c')).toBe(false)
    expect(isVaultLinkUrl('//example.com/a')).toBe(false)
    expect(isVaultLinkUrl('')).toBe(false)
  })
})

describe('resolveVaultLinkTarget', () => {
  it('resolves relative to the active file folder (Obsidian semantics)', () => {
    expect(resolveVaultLinkTarget('a.md', 'docs/notes/current.md')).toBe('docs/notes/a.md')
    expect(resolveVaultLinkTarget('./a.md', 'docs/notes/current.md')).toBe('docs/notes/a.md')
    expect(resolveVaultLinkTarget('../a.md', 'docs/notes/current.md')).toBe('docs/a.md')
    expect(resolveVaultLinkTarget('../../a.md', 'docs/notes/current.md')).toBe('a.md')
  })

  it('resolves a leading slash against the vault root', () => {
    expect(resolveVaultLinkTarget('/a.md', 'docs/notes/current.md')).toBe('a.md')
    expect(resolveVaultLinkTarget('///a/b.md', 'docs/current.md')).toBe('a/b.md')
  })

  it('strips anchor and query suffixes', () => {
    expect(resolveVaultLinkTarget('a.md#heading', 'docs/current.md')).toBe('docs/a.md')
    expect(resolveVaultLinkTarget('a.md?x=1', 'docs/current.md')).toBe('docs/a.md')
  })

  it('returns null for anchor-only links and for escapes above the root', () => {
    expect(resolveVaultLinkTarget('#heading', 'docs/current.md')).toBeNull()
    expect(resolveVaultLinkTarget('?query', 'docs/current.md')).toBeNull()
    // `..` above the root clamps at the root rather than producing `../..`.
    expect(resolveVaultLinkTarget('../../../a.md', 'docs/current.md')).toBe('a.md')
  })
})