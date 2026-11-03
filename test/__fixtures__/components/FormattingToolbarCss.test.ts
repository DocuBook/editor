/** Stylesheet-text contract for the compact bubble menu and the IME strip.
 *
 *  jsdom applies no stylesheets, so these pin the SOURCE of `frontend/index.css`,
 *  the way ModalBackdrop.test.ts does.
 *
 *  1. The IME strip spans the keyboard's full width. Its rule has the same
 *     specificity as the bubble menu's `100vw - 32px` cap, so it only wins by
 *     coming after it.
 *  2. The hidden chevron collapses to zero width instead of `display: none`:
 *     the row has no end padding, and the collapsed chevron's flex gap stands
 *     in for it when the row fits. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Comments stripped, then whitespace-normalised so multi-line rules match. */
const css = readFileSync(resolve(process.cwd(), 'frontend/index.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ')
  .trim()

/** The position and declarations of every rule whose selector list is exactly `selector`. */
const rulesFor = (selector: string) => {
  const out: { index: number; body: string }[] = []
  const pattern = /([^{}]+)\{([^{}]*)\}/g
  for (let match = pattern.exec(css); match; match = pattern.exec(css)) {
    if (match[1].trim() === selector) out.push({ index: match.index, body: match[2] })
  }
  return out
}

describe('formatting toolbar stylesheet', () => {
  it('lets the IME strip lift the bubble menu width cap by coming after it', () => {
    const cap = rulesFor('.bn-mantine .bn-toolbar.formatting-toolbar-scroll')
      .filter((rule) => rule.body.includes('max-width: calc(100vw - 32px)'))
    const strip = rulesFor('.bn-mobile-formatting-toolbar .bn-toolbar.formatting-toolbar-scroll')
      .filter((rule) => rule.body.includes('max-width: none'))
    expect(cap).toHaveLength(1)
    expect(strip).toHaveLength(1)
    expect(strip[0].body).toContain('width: 100%')
    expect(strip[0].index).toBeGreaterThan(cap[0].index)
  })

  it('collapses the hidden chevron instead of removing it from the row', () => {
    const hidden = rulesFor('.bn-mantine .bn-toolbar .formatting-toolbar-pinned.is-hidden')
    expect(hidden).toHaveLength(1)
    expect(hidden[0].body).toContain('width: 0')
    expect(hidden[0].body).not.toMatch(/display\s*:\s*none/)
  })
})
