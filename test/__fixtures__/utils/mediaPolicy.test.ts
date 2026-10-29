// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import {
  BLOCKED_REMOTE_MEDIA,
  BLOCKED_REMOTE_MEDIA_MARKER,
  allowRemoteMediaForSession,
  blockedRemoteMediaPlaceholder,
  blockedRemoteMediaUrl,
  canUseImagePlaceholder,
  forgetRemoteMediaForSession,
  isRemoteMediaAllowedForSession,
  isRemoteMediaUrl,
  isResolvingForImageBlock,
  normalizeRemoteMediaUrl,
  resetSessionRemoteMediaAllowlist,
  runForImageBlock,
} from '../../../frontend/utils/mediaPolicy'

describe('isRemoteMediaUrl', () => {
  it('flags hosts that would be contacted over the network', () => {
    expect(isRemoteMediaUrl('https://cdn.example.com/a.png')).toBe(true)
    expect(isRemoteMediaUrl('http://example.com/a.png')).toBe(true)
    expect(isRemoteMediaUrl('HTTPS://EXAMPLE.COM/a.png')).toBe(true)
    // Protocol-relative inherits the page scheme and is still a remote host.
    expect(isRemoteMediaUrl('//cdn.example.com/a.png')).toBe(true)
    expect(isRemoteMediaUrl('  https://example.com  ')).toBe(true)
  })

  it('leaves local, inline, and vault-relative media alone', () => {
    expect(isRemoteMediaUrl('data:image/png;base64,AAAA')).toBe(false)
    expect(isRemoteMediaUrl('blob:http://localhost/1234')).toBe(false)
    expect(isRemoteMediaUrl('assets/local.png')).toBe(false)
    expect(isRemoteMediaUrl('./local.png')).toBe(false)
    expect(isRemoteMediaUrl('/local.png')).toBe(false)
    expect(isRemoteMediaUrl('')).toBe(false)
  })
})

describe('canUseImagePlaceholder', () => {
  it('accepts URLs that name an image file', () => {
    expect(canUseImagePlaceholder('https://cdn.example.com/a.png')).toBe(true)
    expect(canUseImagePlaceholder('https://cdn.example.com/a.JPG?w=400')).toBe(true)
    expect(canUseImagePlaceholder('https://cdn.example.com/a.svg#frag')).toBe(true)
  })

  it('accepts extensionless URLs, where the type is unknowable', () => {
    expect(canUseImagePlaceholder('https://cdn.example.com/image?id=1')).toBe(true)
    expect(canUseImagePlaceholder('//cdn.example.com/asset')).toBe(true)
  })

  /** The placeholder is an SVG image. Handing it to `<video>`, `<audio>`, or a
   *  file block turns the block into a broken player/link, so those resolve as
   *  they did before this policy existed. */
  it('rejects URLs that name another kind of file', () => {
    expect(canUseImagePlaceholder('https://cdn.example.com/a.mp4')).toBe(false)
    expect(canUseImagePlaceholder('https://cdn.example.com/a.webm')).toBe(false)
    expect(canUseImagePlaceholder('https://cdn.example.com/a.mp3?t=1')).toBe(false)
    expect(canUseImagePlaceholder('https://cdn.example.com/a.pdf')).toBe(false)
    expect(canUseImagePlaceholder('https://cdn.example.com/archive.zip')).toBe(false)
  })
})

describe('blocked placeholder', () => {
  it('exposes a data: placeholder so blocked media never hits the network', () => {
    expect(BLOCKED_REMOTE_MEDIA.startsWith('data:image/svg+xml')).toBe(true)
    expect(BLOCKED_REMOTE_MEDIA).not.toMatch(/^https?:/)
    // Identifiable from the src attribute (pointer cursor) and self-explaining.
    expect(BLOCKED_REMOTE_MEDIA).toContain(BLOCKED_REMOTE_MEDIA_MARKER)
    expect(decodeURIComponent(BLOCKED_REMOTE_MEDIA)).toContain('Click to load this image')
  })
})

describe('normalizeRemoteMediaUrl', () => {
  /** The document is served from an app scheme, so `//host` would inherit that
   *  scheme instead of HTTPS. */
  it('pins protocol-relative URLs to HTTPS', () => {
    expect(normalizeRemoteMediaUrl('//cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png')
  })

  it('leaves absolute and relative URLs alone', () => {
    expect(normalizeRemoteMediaUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png')
    expect(normalizeRemoteMediaUrl('assets/local.png')).toBe('assets/local.png')
    expect(normalizeRemoteMediaUrl('  https://cdn.example.com/a.png  ')).toBe('https://cdn.example.com/a.png')
  })
})

describe('per-image placeholder', () => {
  const url = 'https://cdn.example.com/a.png'

  it('round-trips the URL so a click knows which image to load', () => {
    expect(blockedRemoteMediaUrl(blockedRemoteMediaPlaceholder(url))).toBe(url)
  })

  it('keeps the placeholder local — the URL is only percent-encoded data', () => {
    const placeholder = blockedRemoteMediaPlaceholder(url)
    expect(placeholder.startsWith(BLOCKED_REMOTE_MEDIA)).toBe(true)
    expect(placeholder).not.toContain(url)
  })

  it('rejects anything that is not one of our placeholders', () => {
    expect(blockedRemoteMediaUrl(null)).toBeNull()
    expect(blockedRemoteMediaUrl('')).toBeNull()
    expect(blockedRemoteMediaUrl('https://cdn.example.com/a.png')).toBeNull()
    expect(blockedRemoteMediaUrl('data:image/png;base64,AAAA')).toBeNull()
    // Corrupt percent-encoding must not throw inside a click handler.
    expect(blockedRemoteMediaUrl(`${BLOCKED_REMOTE_MEDIA}#%E0%A0`)).toBeNull()
    // A fragment that decodes to a non-remote URL is not ours to load.
    expect(blockedRemoteMediaUrl(`${BLOCKED_REMOTE_MEDIA}#${encodeURIComponent('assets/local.png')}`)).toBeNull()
  })
})

describe('session allowlist', () => {
  beforeEach(() => resetSessionRemoteMediaAllowlist())

  it('starts empty — nothing is contacted without a click', () => {
    expect(isRemoteMediaAllowedForSession('https://cdn.example.com/a.png')).toBe(false)
  })

  it('allows exactly the URL the reader clicked, not its host', () => {
    allowRemoteMediaForSession('https://cdn.example.com/a.png')

    expect(isRemoteMediaAllowedForSession('https://cdn.example.com/a.png')).toBe(true)
    expect(isRemoteMediaAllowedForSession('https://cdn.example.com/b.png')).toBe(false)
  })

  it('keys protocol-relative URLs by their HTTPS form', () => {
    allowRemoteMediaForSession('//cdn.example.com/a.png')

    expect(isRemoteMediaAllowedForSession('https://cdn.example.com/a.png')).toBe(true)
  })

  it('is forgotten on reset', () => {
    allowRemoteMediaForSession('https://cdn.example.com/a.png')
    resetSessionRemoteMediaAllowlist()

    expect(isRemoteMediaAllowedForSession('https://cdn.example.com/a.png')).toBe(false)
  })

  it('can be forgotten when the image fails to load', () => {
    allowRemoteMediaForSession('https://cdn.example.com/a.png')
    forgetRemoteMediaForSession('https://cdn.example.com/a.png')

    expect(isRemoteMediaAllowedForSession('https://cdn.example.com/a.png')).toBe(false)
  })
})

describe('runForImageBlock', () => {
  it('is on only while an image block renders', () => {
    expect(isResolvingForImageBlock()).toBe(false)

    const during = runForImageBlock(() => isResolvingForImageBlock())

    expect(during).toBe(true)
    expect(isResolvingForImageBlock()).toBe(false)
  })

  it('returns what the render returns', () => {
    expect(runForImageBlock(() => 'dom')).toBe('dom')
  })

  it('is read synchronously: a call made after the first await no longer sees it', async () => {
    let afterAwait: boolean | undefined
    const resolving = runForImageBlock(async () => {
      const synchronous = isResolvingForImageBlock()
      await Promise.resolve()
      afterAwait = isResolvingForImageBlock()
      return synchronous
    })

    expect(await resolving).toBe(true)
    expect(afterAwait).toBe(false)
  })

  it('restores the previous state when nested', () => {
    runForImageBlock(() => {
      runForImageBlock(() => undefined)

      expect(isResolvingForImageBlock()).toBe(true)
    })

    expect(isResolvingForImageBlock()).toBe(false)
  })

  it('is cleared when the render throws', () => {
    expect(() => runForImageBlock(() => { throw new Error('render failed') })).toThrow('render failed')

    expect(isResolvingForImageBlock()).toBe(false)
  })
})

