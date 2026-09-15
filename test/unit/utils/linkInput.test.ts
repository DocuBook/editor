import { describe, expect, it } from 'vitest'
import { looksLikeLink, resolveLinkInput } from '../../../frontend/utils/linkInput'

/** Mirrors what `wiki_suggest` returns: the picked row contributes only its
 *  title, which the caller wraps as `[[title]]`. */
const hits = [{ title: 'Roadmap' }, { title: 'notes/ideas' }]

describe('looksLikeLink', () => {
  it('accepts a URL scheme', () => {
    expect(looksLikeLink('https://example.com/a?b=1#c')).toBe(true)
    expect(looksLikeLink('http://example.com')).toBe(true)
    expect(looksLikeLink('mailto:me@example.com')).toBe(true)
    expect(looksLikeLink('tel:+123')).toBe(true)
  })

  it('accepts vault-root, relative and protocol-relative paths', () => {
    expect(looksLikeLink('/notes/a.md')).toBe(true)
    expect(looksLikeLink('./a.md')).toBe(true)
    expect(looksLikeLink('../a.md')).toBe(true)
    expect(looksLikeLink('//example.com')).toBe(true)
  })

  it('accepts a bare anchor', () => {
    expect(looksLikeLink('#heading')).toBe(true)
  })

  it('rejects a note-name query', () => {
    expect(looksLikeLink('Roadmap')).toBe(false)
    expect(looksLikeLink('My Note')).toBe(false)
    expect(looksLikeLink('notes/ideas')).toBe(false)
  })

  /** A bare host or file name has no marker to tell it apart from a note name,
   *  so it must go through the suggestion search first. */
  it('rejects a bare host or file name', () => {
    expect(looksLikeLink('example.com')).toBe(false)
    expect(looksLikeLink('note.md')).toBe(false)
  })

  it('rejects the empty string', () => {
    expect(looksLikeLink('')).toBe(false)
  })
})

describe('resolveLinkInput', () => {
  it('returns null for empty or whitespace-only input', () => {
    expect(resolveLinkInput('', hits, 0)).toBeNull()
    expect(resolveLinkInput('   ', hits, 0)).toBeNull()
  })

  it('submits a link target as-typed — no protocol forcing', () => {
    expect(resolveLinkInput('https://example.com', hits, 0)).toEqual({ kind: 'link', target: 'https://example.com' })
    expect(resolveLinkInput('./folder.md', hits, 0)).toEqual({ kind: 'link', target: './folder.md' })
    expect(resolveLinkInput('example.com', [], 0)).toEqual({ kind: 'link', target: 'example.com' })
  })

  it('trims the submitted target', () => {
    expect(resolveLinkInput('  https://example.com  ', [], 0)).toEqual({ kind: 'link', target: 'https://example.com' })
  })

  it('inserts a wikilink when the query resolved to a suggestion', () => {
    expect(resolveLinkInput('Road', hits, 0)).toEqual({ kind: 'wikilink', title: 'Roadmap' })
    expect(resolveLinkInput('ideas', hits, 1)).toEqual({ kind: 'wikilink', title: 'notes/ideas' })
  })

  /** Arrow keys clamp to the list length, so `selected` can only be out of
   *  range while the list is empty — the fallback is what keeps a pasted bare
   *  host from becoming a dead end. */
  it('falls back to a link when nothing matched', () => {
    expect(resolveLinkInput('Road', [], 0)).toEqual({ kind: 'link', target: 'Road' })
    expect(resolveLinkInput('Road', hits, 5)).toEqual({ kind: 'link', target: 'Road' })
  })

  /** Link-looking text ignores the suggestion list: a URL typed while stale
   *  note hits are on screen must not be swallowed by one of them. */
  it('never picks a suggestion for link-looking input', () => {
    expect(resolveLinkInput('https://example.com', hits, 0)).toEqual({ kind: 'link', target: 'https://example.com' })
    expect(resolveLinkInput('#anchor', hits, 0)).toEqual({ kind: 'link', target: '#anchor' })
  })
})
