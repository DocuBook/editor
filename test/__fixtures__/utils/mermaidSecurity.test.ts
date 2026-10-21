import { describe, expect, it, vi } from 'vitest'

/** Mermaid renders note-supplied text into SVG that the preview injects with
 *  `dangerouslySetInnerHTML`. `securityLevel: 'strict'` is what makes Mermaid
 *  sanitize that output, so the regression this file guards is a silent
 *  downgrade — by a library upgrade changing its default, or by a caller
 *  passing its own options.
 *
 *  Real rendering is not exercised here: Mermaid needs SVG layout APIs
 *  (`getBBox`, `getComputedTextLength`) that jsdom does not implement, so a
 *  render-based test would hang. The security contract we own is the config we
 *  hand Mermaid, and that is what is asserted. */
const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
  parse: vi.fn(),
}))

vi.mock('mermaid', () => ({ default: mermaid }))
vi.mock('../../../frontend/utils/mathRenderCache', () => ({ installKatexRenderCache: () => {} }))

import { installRenderCaches } from '../../../frontend/utils/renderCacheInstall'

const originalInitialize = mermaid.initialize

describe('mermaid security pinning', () => {
  it('forces strict on every initialize call, including library defaults', () => {
    installRenderCaches()

    // @blocknote/diagram-block calls exactly this shape: its own options, no
    // securityLevel at all.
    mermaid.initialize({ htmlLabels: false, startOnLoad: false, suppressErrorRendering: true })

    expect(originalInitialize).toHaveBeenLastCalledWith({
      htmlLabels: false,
      startOnLoad: false,
      suppressErrorRendering: true,
      securityLevel: 'strict',
    })
  })

  it('cannot be downgraded by a caller that asks for loose', () => {
    installRenderCaches()

    mermaid.initialize({ securityLevel: 'loose' })

    expect(originalInitialize).toHaveBeenLastCalledWith({ securityLevel: 'strict' })
  })

  it('pins strict even when initialize is called with no options', () => {
    installRenderCaches()

    mermaid.initialize()

    expect(originalInitialize).toHaveBeenLastCalledWith({ securityLevel: 'strict' })
  })
})
