/** Stylesheet-text contract for the modal backdrop and the Mantine cascade layer.
 *
 *  jsdom applies no stylesheets, so these pin the SOURCE of `frontend/index.css`
 *  (and the entrypoint), the way ColdOpenGuard.test.ts does. The rendered
 *  behaviour was checked in Chromium and WebKit when this landed.
 *
 *  1. Mantine's stylesheet lives in its own cascade layer between Tailwind's
 *     `base` and `utilities`. Unlayered, its global
 *     `input, button, textarea, select { font: inherit }` beat every Tailwind
 *     class on those elements. Below `base`, preflight would strip Mantine's
 *     components instead.
 *  2. The frosted glass is the modal BACKDROP. A dialog surface is opaque and
 *     carries no backdrop-filter. WKWebView on macOS 12 (and Playwright's WebKit)
 *     report `@supports` for backdrop-filter yet paint no reliable blur, so a
 *     translucent dialog let the page's text show through its own content.
 *  3. The blur ships both forms (-webkit- is required up to Safari 17) in
 *     SEPARATE @supports rules. Lightning CSS collapses a same-rule pair for the
 *     safari15 target. It uses no selector Safari 15.4 lacks. */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const indexCss = readFileSync(resolve(root, 'frontend/index.css'), 'utf8')
const mainTsx = readFileSync(resolve(root, 'frontend/main.tsx'), 'utf8')
/** Comments stripped (they quote the very declarations asserted absent), then
 *  whitespace-normalised so multi-line rules match one-line needles. */
const css = indexCss.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim()

/** Every rule whose selector list mentions `selector`, with its declarations. */
const rulesFor = (selector: string) => {
  const out: { selectors: string; body: string }[] = []
  const pattern = /([^{}]+)\{([^{}]*)\}/g
  for (let match = pattern.exec(css); match; match = pattern.exec(css)) {
    const selectors = match[1].trim()
    if (selectors.split(',').some((part) => part.trim().split(/\s+/).includes(selector))) out.push({ selectors, body: match[2] })
  }
  return out
}

/** The bodies of every `@supports (<query>) { … }` block, nested rules included. */
const supportsBlocks = (query: string) => {
  const out: string[] = []
  for (let start = css.indexOf(`@supports ${query}`); start !== -1; start = css.indexOf(`@supports ${query}`, start + 1)) {
    const open = css.indexOf('{', start)
    let depth = 0
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1
      else if (css[i] === '}' && --depth === 0) { out.push(css.slice(open + 1, i)); break }
    }
  }
  return out
}

describe('Mantine cascade layer', () => {
  it('declares the layer order before anything else, with mantine between base and utilities', () => {
    const order = css.match(/^@layer ([\w, ]+);/)
    expect(order, 'the layer order must be the first statement').not.toBeNull()
    const layers = order![1].split(',').map((name) => name.trim())
    // `properties` (Tailwind's --tw-* fallbacks) stays lowest: above utilities
    // it would reset --tw-shadow & co. on the engines that use the fallback.
    expect(layers).toEqual(['properties', 'theme', 'base', 'mantine', 'components', 'utilities'])
  })

  it('imports the layered Mantine build from the stylesheet, not the unlayered one from JS', () => {
    expect(css).toContain('@import "@mantine/core/styles.layer.css";')
    expect(mainTsx).not.toMatch(/@mantine\/core\/styles\.css/)
  })
})

describe('modal backdrop', () => {
  it('gives every modal backdrop, the Mantine drawer overlay included, the dim tint', () => {
    const tint = rulesFor('.ui-backdrop').filter((rule) => rule.body.includes('background: var(--color-overlay)'))
    expect(tint).toHaveLength(1)
    // Outranks Mantine's Overlay rule, which BlockNote re-imports unlayered.
    expect(tint[0].selectors).toContain('body .mobile-sidebar-drawer-overlay')
  })

  it('blurs the backdrop with each vendor form in its own @supports rule', () => {
    const standard = supportsBlocks('(backdrop-filter: blur(1px))')
    const prefixed = supportsBlocks('(-webkit-backdrop-filter: blur(1px))')
    expect(standard.some((block) => /\.ui-backdrop[^{]*\{ ?backdrop-filter: blur\(var\(--backdrop-blur\)\);? ?\}/.test(block))).toBe(true)
    expect(prefixed.some((block) => /\.ui-backdrop[^{]*\{ ?-webkit-backdrop-filter: blur\(var\(--backdrop-blur\)\);? ?\}/.test(block))).toBe(true)
    expect(css).toMatch(/--backdrop-blur: \d+px;/)
  })

  it('keeps dialog and popover surfaces opaque and unfiltered', () => {
    for (const surface of ['.ui-dialog', '.ui-popover']) {
      for (const rule of rulesFor(surface)) {
        expect(rule.body, `${rule.selectors}`).not.toMatch(/backdrop-filter/)
        if (/background\s*:/.test(rule.body)) expect(rule.body, `${rule.selectors}`).toContain('background: var(--color-surface)')
      }
    }
    // The translucent dialog token is gone, not just unused.
    expect(css).not.toContain('--color-surface-raised')
  })

  it('uses no selector that Safari 15.4 (macOS 12 WKWebView) cannot parse', () => {
    for (const rule of [...rulesFor('.ui-backdrop'), ...rulesFor('.ui-dialog'), ...rulesFor('.ui-popover')]) {
      expect(rule.selectors).not.toMatch(/:has\(/)
    }
  })

  it('puts every modal on the shared backdrop instead of an ad-hoc tint', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (path.endsWith('.tsx') && /\bbg-overlay\b/.test(readFileSync(path, 'utf8'))) offenders.push(path)
      }
    }
    walk(resolve(root, 'frontend'))
    expect(offenders).toEqual([])
  })
})
