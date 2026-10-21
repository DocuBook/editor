// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const opened = vi.hoisted(() => ({ external: [] as string[], files: [] as string[] }))
const toasts = vi.hoisted(() => ({ errors: [] as string[] }))

vi.mock('../../../frontend/utils/externalLink', () => ({
  openExternalLink: vi.fn(async (url: string) => { opened.external.push(url) }),
}))
vi.mock('sonner', () => ({
  toast: { error: (message: string) => { toasts.errors.push(message) } },
}))
vi.mock('../../../frontend/stores/editor', () => ({
  useEditorStore: {
    getState: () => ({
      activeTab: 'notes/current.md',
      openFile: async (path: string) => { opened.files.push(path) },
    }),
  },
}))

import { handleEditorLinkClick } from '../../../frontend/utils/linkClickPolicy'

/** A click on a link, as ProseMirror delivers it: `handleClick` runs BEFORE the
 *  browser's default action, so the handler — not a dispatched DOM event — is
 *  what decides whether the anchor is followed. Dispatching a real click here
 *  would let jsdom perform the default navigation (including evaluating a
 *  `javascript:` href), which is exactly what the handler exists to prevent. */
const click = (href: string, text = 'link') => {
  const anchor = document.createElement('a')
  anchor.setAttribute('href', href)
  anchor.textContent = text
  const event = {
    target: anchor,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
  }
  return { event, handled: handleEditorLinkClick(event as unknown as MouseEvent) }
}

beforeEach(() => {
  opened.external.length = 0
  opened.files.length = 0
  toasts.errors.length = 0
})

/** In-document link clicks used to reach BlockNote's default handler, which
 *  calls `window.open(href)` for ANY scheme its `isAllowedUri` check accepts —
 *  including custom protocols — while the link toolbar only allows
 *  http/https/mailto/tel. The editor now applies the toolbar's policy. */
describe('editor link click policy', () => {
  it('ignores clicks that did not land on a link', () => {
    const paragraph = document.createElement('p')
    const event = {
      target: paragraph,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true },
    }

    expect(handleEditorLinkClick(event as unknown as MouseEvent)).toBe(false)
    expect(event.defaultPrevented).toBe(false)
  })

  it('opens allowlisted external URLs through the shared opener', () => {
    const { handled } = click('https://example.com/page')

    expect(handled).toBe(true)
    expect(opened.external).toEqual(['https://example.com/page'])
  })

  it('allows mailto and tel links', () => {
    click('mailto:someone@example.com')
    click('tel:+15551234')

    expect(opened.external).toEqual(['mailto:someone@example.com', 'tel:+15551234'])
  })

  it('blocks javascript, data, file and custom schemes', () => {
    for (const href of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'obsidian://open?vault=x',
      'myapp://do-something',
      'ftp://example.com/x',
    ]) {
      const { handled, event } = click(href)

      expect(handled).toBe(true)
      expect(event.defaultPrevented).toBe(true)
    }

    expect(opened.external).toEqual([])
    expect(toasts.errors).toHaveLength(7)
  })

  it('opens a vault-relative link in the app, resolved against the active file', () => {
    const { handled } = click('notes/target.md')

    expect(handled).toBe(true)
    expect(opened.files).toEqual(['notes/notes/target.md'])
    expect(opened.external).toEqual([])
  })

  it('resolves ./ and ../ against the active file folder', () => {
    click('./sibling.md')
    click('../up.md')

    expect(opened.files).toEqual(['notes/sibling.md', 'up.md'])
  })

  it('treats a protocol-relative URL as external, never as a vault path', () => {
    const { handled } = click('//example.com/x')

    expect(handled).toBe(true)
    // The opener applies the allowlist and pins protocol-relative URLs to
    // https (see safeExternalUrl); the policy's job is only the branch.
    expect(opened.external).toEqual(['//example.com/x'])
    expect(opened.files).toEqual([])
  })

  it('does nothing for an anchor-only link', () => {
    const { handled, event } = click('#section-2')

    expect(handled).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(opened.files).toEqual([])
    expect(opened.external).toEqual([])
    expect(toasts.errors).toEqual([])
  })

  it('always prevents the browser from following the anchor', () => {
    const { event } = click('https://example.com')

    expect(event.defaultPrevented).toBe(true)
  })
})
