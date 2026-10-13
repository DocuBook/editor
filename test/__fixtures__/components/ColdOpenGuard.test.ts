// @vitest-environment jsdom

/** The cold-open guard (see the authoritative explanation in `index.html`) must
 *  ship in the DOCUMENT HEAD, not (only) a late stylesheet.
 *
 *  That is a DOM-order problem, not a styling one: the raw source is appended as
 *  a direct child of the node view renderer before the popup / `pre > code`
 *  exists, and BlockNote's own rule arrives too late to cover it. Only a rule
 *  parsed before any script runs can win that race.
 *
 *  jsdom applies no stylesheets, so a paint assertion here would be theatre. What
 *  this CAN pin is that the guard is in the head, targets the exact elements, and
 *  is UNCONDITIONAL — every source-backed node view, code block included, is
 *  appended the same way on a cold mount. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Resolved from the project root (vitest's cwd), the same way the config and
// other fixture tests reach repo-level files.
const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')

/** The <style> block the head carries, whitespace-normalised for matching. */
const headStyle = (() => {
  const match = indexHtml.match(/<style>([\s\S]*?)<\/style>/)
  return (match?.[1] ?? '').replace(/\s+/g, ' ')
})()

const normalisedHtml = indexHtml.replace(/\s+/g, ' ')

describe('cold-open guard in index.html', () => {
  it('is inlined in the document head, before the module script', () => {
    const styleAt = indexHtml.indexOf('<style>')
    const scriptAt = indexHtml.indexOf('<script')
    expect(styleAt).toBeGreaterThan(-1)
    expect(scriptAt).toBeGreaterThan(-1)
    // Parsed before any script runs — the whole point of inlining it.
    expect(styleAt).toBeLessThan(scriptAt)
  })

  it('hides the contentDOM whenever it is a direct child of a node view renderer', () => {
    // The direct-child append — for EVERY source-backed node view, the code
    // block included — is what paints raw source on a cold mount.
    expect(headStyle).toContain(
      '.bn-react-node-view-renderer > [data-node-view-content-react] { visibility: hidden; }',
    )
  })

  it('does not exclude the code block — its source is appended the same way', () => {
    // A code block has no separate preview, but its contentDOM is STILL appended
    // as a bare direct child during the cold window (then re-parented into
    // `pre > code`). Excluding it let the raw code paint that frame — the flash
    // this guard exists to stop. After settle it is never a direct child, so no
    // code-block source is hidden by this rule.
    expect(headStyle).not.toContain('node-codeBlock')
  })

  it('hides a closed source popup and restores it when open', () => {
    expect(headStyle).toContain(
      ".bn-preview-with-source-popup:not([data-open='true']) .bn-source-block-popup { visibility: hidden; }",
    )
    expect(headStyle).toContain(
      ".bn-preview-with-source-popup[data-open='true'] .bn-source-block-popup { visibility: visible; }",
    )
  })

  it('targets the real BlockNote class names the popup and node view ship', () => {
    // Guards against a silent upstream rename turning the guard into dead CSS.
    for (const cls of ['bn-preview-with-source-popup', 'bn-source-block-popup', 'bn-react-node-view-renderer', 'data-node-view-content-react']) {
      expect(normalisedHtml).toContain(cls)
    }
  })
})
