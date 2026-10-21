import { describe, expect, it } from 'vitest'
import { looksLikeLink, resolveLinkInput, safeExternalUrl } from '../../../frontend/utils/linkInput'

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

describe('safeExternalUrl', () => {
  it('allows ordinary web and contact links', () => {
    expect(safeExternalUrl('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c')
    expect(safeExternalUrl('http://example.com')).toBe('http://example.com/')
    expect(safeExternalUrl('mailto:me@example.com')).toBe('mailto:me@example.com')
    expect(safeExternalUrl('tel:+123')).toBe('tel:+123')
  })

  it('trims surrounding whitespace', () => {
    expect(safeExternalUrl('  https://example.com  ')).toBe('https://example.com/')
  })

  /** A note is untrusted content: these schemes are code/navigation primitives,
   *  not links, and must never reach the OS opener. */
  it('rejects script, data, file and app-specific schemes', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(safeExternalUrl('JavaScript:alert(1)')).toBeNull()
    expect(safeExternalUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(safeExternalUrl('file:///etc/passwd')).toBeNull()
    expect(safeExternalUrl('obsidian://open?vault=x')).toBeNull()
  })

  it('rejects empty input and non-URL text', () => {
    expect(safeExternalUrl('')).toBeNull()
    expect(safeExternalUrl('   ')).toBeNull()
    expect(safeExternalUrl('example.com')).toBeNull()
  })

  /** `//host` is a valid web URL but would be a bare path on desktop and would
   *  resolve against the app origin in a browser — pin it to https. */
  it('pins protocol-relative links to https', () => {
    expect(safeExternalUrl('//example.com/x')).toBe('https://example.com/x')
    expect(safeExternalUrl('//evil.example/javascript:alert(1)')).toBe('https://evil.example/javascript:alert(1)')
  })
})
