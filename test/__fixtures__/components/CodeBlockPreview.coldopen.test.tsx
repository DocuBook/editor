// @vitest-environment jsdom

/** Cold-open behaviour of the CODE BLOCK preview — PARITY with the diagram.
 *
 *  The contract: a code block on a first (cold) mount shows the loading
 *  placeholder for its first paint, then swaps in the real source view (header +
 *  `pre > code`). This is the one preview whose render is what it IS — there is
 *  no separate output — so the gate is the only loading state it can have, and
 *  it is what stops a document full of code blocks from painting every source
 *  body at once on open.
 *
 *  It pins the two halves that matter together: the skeleton IS the first paint,
 *  and the real `pre > code` (with its `language-*` class the exporter, Shiki and
 *  the freeze contract all depend on) is what follows, unchanged. */

import { act } from 'react'
import type { Root } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { BlockNoteContext } from '@blocknote/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
Object.assign(window, {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }),
})
Object.assign(Element.prototype, { scrollIntoView: () => {} })

// setup.ts reaches the diagram preview module, and that one imports Mermaid
// eagerly — none of it is exercised here, so both are stubbed out.
vi.mock('mermaid', () => ({ default: { render: vi.fn(), initialize: vi.fn() } }))
vi.mock('react-icons/si', () => ({ SiMermaid: () => null }))
vi.mock('@blocknote/diagram-block', () => ({
  createDiagramBlockConfig: () => ({}),
  parseDiagramCodeContent: () => {},
  parseDiagramCodeElement: () => undefined,
  getDiagramDictionary: () => ({ block: {} }),
  initializeMermaid: () => {},
  trimDiagramSVG: (svg: string) => svg,
  withSVGFontFamily: (svg: string) => svg,
}))

import { mountCold, settle } from '../harness'
import { StableCodeBlockPreview, setPreviewRenderingPaused } from '../../../frontend/components/editor/setup'

let container: HTMLDivElement
let root: Root

const editor = {
  isEditable: true,
  updateBlock: vi.fn(),
  _tiptapEditor: { on() {}, off() {} },
}

const mountColdBlock = (info: string) => {
  ;({ container, root } = mountCold(
    <BlockNoteContext.Provider value={{ editor } as any}>
      <MantineProvider>
        <StableCodeBlockPreview
          {...({
            block: { id: 'block-1', props: { language: info } },
            editor,
            contentRef: () => {},
          } as any)}
        />
      </MantineProvider>
    </BlockNoteContext.Provider>,
  ))
}

afterEach(() => {
  act(() => setPreviewRenderingPaused(false))
  act(() => root.unmount())
  container.remove()
})

describe('codeBlock preview on a cold mount', () => {
  it('shows the skeleton first, then the source view', async () => {
    mountColdBlock('ts title="file.ts"')

    // First paint: skeleton, no header, no `pre`.
    expect(container.querySelector('[data-testid="preview-skeleton"]')).not.toBeNull()
    expect(container.querySelector('pre > code')).toBeNull()
    expect(container.querySelector('.code-block-header')).toBeNull()

    await settle()

    // Gate opened: the real source view, and the skeleton is gone.
    const code = container.querySelector('pre > code')!
    expect(code.className).toBe('language-ts')
    expect(code.getAttribute('data-language')).toBe('ts title="file.ts"')
    expect(container.querySelector('[data-testid="preview-skeleton"]')).toBeNull()
  })

  it('still opens on the skeleton, not the source view, while the freeze is on', async () => {
    // A cold block that inherits the paused flag must not bare-paint its source;
    // it opens on the skeleton like every other cold preview.
    act(() => setPreviewRenderingPaused(true))

    mountColdBlock('js')

    expect(container.querySelector('[data-testid="preview-skeleton"]')).not.toBeNull()
    expect(container.querySelector('pre > code')).toBeNull()

    await settle()

    expect(container.querySelector('pre > code')).not.toBeNull()
  })
})
