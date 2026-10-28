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
 *  jsdom applies no stylesheets, so a computed-style or paint assertion here
 *  would be theatre. What this CAN pin is the *source* of the stylesheet and the
 *  entrypoint: that no preview-targeting guard has returned. */

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
