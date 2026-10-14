// @vitest-environment jsdom

/** Stylesheet-text contract for the cold-open source regression tracked in
 *  issue #263.
 *
 *  History: PR #259 shipped a "cold-open guard" that hid raw source by inlining
 *  a `<style>` block in the document head and relying on inherited
 *  `visibility: hidden`. On WebKit / macOS 12 (Safari 15) that broke Mermaid
 *  SVG and KaTeX previews, because `visibility` inherits into the injected
 *  preview subtree and WebKit does not reliably repaint after the rule stops
 *  matching. PR #264 reverted #259 (`569d272`), so `master` is now guard-free.
 *
 *  What survives, and what this file pins, is the Safari 15 fallback in
 *  `frontend/index.css`: an `@supports not (overflow: clip)` block that used a
 *  `#root` prefix. An id selector outscores BlockNote's own
 *  `.bn-source-block-popup { … overflow: clip }` rule, re-creating the cascade
 *  fight the revert was meant to remove. The fallback must stay at BlockNote's
 *  class specificity.
 *
 *  jsdom applies no stylesheets, so a computed-style or paint assertion here
 *  would be theatre. What this CAN pin is the *source* of the stylesheet and the
 *  entrypoint: which selectors exist, at what specificity, and that no
 *  preview-targeting guard has returned. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Resolved from the project root (vitest's cwd), the same way the config and
// other fixture tests reach repo-level files.
const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')
const indexCss = readFileSync(resolve(process.cwd(), 'frontend/index.css'), 'utf8')

/** Whitespace-normalised so multi-line selectors match a one-line needle. */
const normalisedHtml = indexHtml.replace(/\s+/g, ' ')
const normalisedCss = indexCss.replace(/\s+/g, ' ')

/** The `@supports not (overflow: clip)` block, isolated from the rest of the
 *  stylesheet so assertions cannot accidentally match unrelated rules. */
const safariFallback = (() => {
  const start = normalisedCss.indexOf('@supports not (overflow: clip)')
  if (start === -1) return ''
  const open = normalisedCss.indexOf('{', start)
  let depth = 0
  for (let i = open; i < normalisedCss.length; i += 1) {
    if (normalisedCss[i] === '{') depth += 1
    else if (normalisedCss[i] === '}') {
      depth -= 1
      if (depth === 0) return normalisedCss.slice(open + 1, i)
    }
  }
  return normalisedCss.slice(open + 1)
})()

/** Selector-specificity score (a,b,c): id, class/attr/pseudo-class, element. */
const specificity = (selector: string): [number, number, number] => {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length
  const classes = (selector.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+(?:\([^)]*\))?/g) ?? []).length
  const elements = (selector.match(/(^|\s|>|\+|~)[a-z][\w-]*/g) ?? []).length
  return [ids, classes, elements]
}

const outranks = (a: [number, number, number], b: [number, number, number]) => {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

/** Split a rule body into `selector { … }` declarations, ignoring at-rules. */
const rules = (body: string) =>
  body
    .split('}')
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => {
      const at = block.lastIndexOf('{')
      return { selector: block.slice(0, at).trim(), declaration: block.slice(at + 1).trim() }
    })

/** BlockNote's own popup-collapse selector, kept here verbatim so the assertion
 *  reads as "our fallback must not beat THIS rule". */
const BLOCKNOTE_POPUP_SELECTOR = '.bn-preview-with-source-popup[data-open="true"] .bn-source-block-popup'

describe('cold-open guard must not return', () => {
  it('ships no inlined guard in the document head', () => {
    // The guard's whole premise was a <style> parsed before any script runs.
    expect(indexHtml).not.toContain('<style>')
  })

  it('has no pre-script guard in the guard-free entrypoint', () => {
    // Only the root element and the module script belong between <body> tags.
    expect(normalisedHtml).toContain('<div id="root"></div> <script type="module" src="/frontend/main.tsx"></script>')
  })

  it('never hides a node view contentDOM through a cold-open rule', () => {
    // The reverted rule hid `[data-node-view-content-react]` while it was a
    // direct child during the cold window. No such rule may come back.
    expect(normalisedCss).not.toMatch(/\[data-node-view-content-react\]\s*\{[^}]*visibility:\s*hidden/)
  })

  it('never hides the source popup with inherited visibility', () => {
    expect(normalisedCss).not.toMatch(/\.bn-source-block-popup\s*\{[^}]*visibility:\s*hidden/)
  })
})

describe('Safari 15 fallback stays at BlockNote specificity', () => {
  it('does not prefix the fallback selectors with #root', () => {
    expect(safariFallback).not.toBe('')
    expect(safariFallback).not.toContain('#root')
  })

  it('keeps both declared fallbacks (popup collapse + empty code input)', () => {
    expect(normalisedCss).toContain('@supports not (overflow: clip)')
    expect(safariFallback).toContain('.bn-source-block-popup')
    expect(safariFallback).toContain('overflow: hidden')
    expect(safariFallback).toContain('.bn-code-block-source-popup-input-empty')
  })

  it('targets no id-selector rule that outranks BlockNote popup rules', () => {
    const vendor = specificity(BLOCKNOTE_POPUP_SELECTOR)
    for (const rule of rules(safariFallback)) {
      // Every fallback selector that touches the popup subtree — or any
      // selector at all — must not outrank the vendor popup rule.
      expect(outranks(specificity(rule.selector), vendor)).toBe(false)
    }
  })

  it('keeps the popup-collapse selector on classes/attributes only', () => {
    const popupRule = rules(safariFallback).find(rule => rule.selector.includes('.bn-source-block-popup'))
    expect(popupRule).toBeDefined()
    const [ids] = specificity(popupRule!.selector)
    expect(ids).toBe(0)
  })
})
