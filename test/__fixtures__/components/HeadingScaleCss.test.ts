/** Stylesheet-text contract for the editor's heading scale.
 *
 *  jsdom applies no stylesheets, so these pin the SOURCE of `frontend/index.css`,
 *  the way FormattingToolbarCss.test.ts does.
 *
 *  1. Headings are sized through BlockNote's `--level`, not on the h1–h5
 *     element: upstream resets that to `font-size: inherit` from a later sheet
 *     of equal specificity, which silently voided the old `h1 { font-size }`.
 *  2. On desktop and on phones (< 640px) each level is smaller than the one
 *     above it and never smaller than body text. */

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

const LEVELS = [1, 2, 3, 4, 5]
const PHONE = '@media (max-width: 639px) {'

/** `--heading-N` values in em from one rule body, merged over `base`. */
const scaleOf = (body: string, base: Record<number, number> = {}) => {
  const scale = { ...base }
  for (const [, level, value] of body.matchAll(/--heading-(\d): ([\d.]+)em/g)) scale[Number(level)] = Number(value)
  return scale
}

const scaleRules = rulesFor('#root .bn-editor').filter(rule => rule.body.includes('--heading-'))
const desktopRule = scaleRules.find(rule => !css.slice(0, rule.index + 1).trimEnd().endsWith(PHONE))
const phoneRule = scaleRules.find(rule => css.slice(0, rule.index + 1).trimEnd().endsWith(PHONE))

describe('editor heading scale stylesheet', () => {
  it('sizes every level through --level', () => {
    expect(rulesFor('#root .bn-editor [data-content-type="heading"]')[0]?.body).toContain('--level: var(--heading-1)')
    for (const level of LEVELS.slice(1)) {
      expect(rulesFor(`#root .bn-editor [data-content-type="heading"][data-level="${level}"]`)[0]?.body).toContain(`--level: var(--heading-${level})`)
    }
    for (const level of LEVELS) {
      for (const rule of rulesFor(`.ProseMirror h${level}`)) expect(rule.body).not.toMatch(/font-size|margin/)
    }
  })

  it.each([['desktop'], ['phone']])('steps down from h1 to h5 without going under body size on %s', (name) => {
    expect(desktopRule).toBeDefined()
    const desktop = scaleOf(desktopRule!.body)
    const scale = name === 'desktop' ? desktop : (expect(phoneRule).toBeDefined(), scaleOf(phoneRule!.body, desktop))
    expect(Object.keys(scale).map(Number)).toEqual(LEVELS)
    for (const level of LEVELS.slice(1)) expect(scale[level]).toBeLessThan(scale[level - 1])
    expect(scale[5]).toBeGreaterThanOrEqual(1)
  })

  it('tightens the scale on phones', () => {
    const desktop = scaleOf(desktopRule!.body)
    const phone = scaleOf(phoneRule!.body, desktop)
    expect(phone[1]).toBeLessThan(desktop[1])
    for (const level of LEVELS) expect(phone[level]).toBeLessThanOrEqual(desktop[level])
  })
})
