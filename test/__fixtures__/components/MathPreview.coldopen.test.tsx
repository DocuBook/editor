// @vitest-environment jsdom

/** Cold-open behaviour of the math previews — PARITY with the diagram preview.
 *
 *  The contract: on a first (cold) mount, every source-backed preview shows the
 *  loading placeholder for its first paint, then swaps in the real render. Math
 *  used to be the exception, on the reasoning that KaTeX is synchronous so there
 *  is no gap to fill. That reasoning describes the renderer, not the UX: the
 *  product decision is that a cold open looks the same for all four kinds, so
 *  math gets the same explicit first-paint gate as the diagram.
 *
 *  This pins BOTH halves of the contract: the skeleton IS the cold (first) paint
 *  (block and inline shapes), raw source never appears, and the formula replaces
 *  the skeleton once the gate opens. It exercises the `StableMath*` wrappers from
 *  setup.ts — the ones the app actually mounts — so the freeze path is covered
 *  for math, not just the code block. */

import { act } from 'react'
import type { Root } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { BlockNoteContext } from '@blocknote/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
Object.assign(window, {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }),
})

vi.mock('mermaid', () => ({ default: { render: vi.fn(), initialize: vi.fn() } }))
vi.mock('react-icons/si', () => ({ SiMermaid: () => null }))
vi.mock('react-icons/tb', () => ({ TbMathFunction: () => null }))
vi.mock('@blocknote/diagram-block', () => ({
  createDiagramBlockConfig: () => ({}),
  parseDiagramCodeContent: () => {},
  parseDiagramCodeElement: () => undefined,
  getDiagramDictionary: () => ({ block: {} }),
  initializeMermaid: () => {},
  trimDiagramSVG: (svg: string) => svg,
  withSVGFontFamily: (svg: string) => svg,
}))

// The real `SourceWithPreview` pulls in popup internals that need a full editor
// (block: MathBlockPreviewWithPopup -> SourceBlockWithPreview -> useSourceBlockPreviewPopup).
// This stub keeps the part under test — what `preview` resolves to and whether a
// skeleton appears — while dropping the popup plumbing, matching how the diagram
// preview test isolates the same seam.
vi.mock('@blocknote/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@blocknote/react')>()
  const Frame = ({ preview, error, errorPreview }: { preview?: unknown; error?: unknown; errorPreview?: unknown }) => (
    <>
      <div data-error={error == null ? '' : 'error'} />
      <div data-has-preview={preview == null ? '' : 'true'} />
      {preview ?? null}
      {error != null ? errorPreview ?? null : null}
    </>
  )
  return {
    ...actual,
    SourceBlockWithPreview: Frame,
    SourceInlineContentWithPreview: Frame,
  }
})

import { mountCold, settle } from '../harness'
import { StableMathBlockPreview, StableMathInlinePreview, setPreviewRenderingPaused } from '../../../frontend/components/editor/setup'

let container: HTMLDivElement
let root: Root

const editor = {
  isEditable: true,
  domElement: document.createElement('div'),
  updateBlock: vi.fn(),
  // Math previews read `editor.dictionary.math` and fall back to bundled English
  // when it is absent, so an empty dictionary exercises the real render path.
  dictionary: {},
  _tiptapEditor: { on() {}, off() {} },
}

const coldRender = (Source: any, props: any) => {
  ;({ container, root } = mountCold(
    <BlockNoteContext.Provider value={{ editor } as any}>
      <MantineProvider>
        <Source {...props} />
      </MantineProvider>
    </BlockNoteContext.Provider>,
  ))
}

const blockProps = (source: string) => ({
  block: { id: 'b1', content: source },
  editor,
  contentRef: () => {},
})

const inlineProps = (source: string) => ({
  inlineContent: { content: source },
  editor,
  contentRef: () => {},
  node: { nodeSize: 1 },
  getPos: () => 0,
})

afterEach(() => {
  act(() => setPreviewRenderingPaused(false))
  act(() => root.unmount())
  container.remove()
})

describe('math preview on a cold mount', () => {
  it('block equation shows the block skeleton first, then the formula', async () => {
    const source = String.raw`\int_0^1 x^2 \, dx = \frac{1}{3}`
    coldRender(StableMathBlockPreview, blockProps(source))

    // First paint: skeleton, and NOT the raw source.
    expect(container.querySelector('[data-testid="preview-skeleton"]')).not.toBeNull()
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.textContent).not.toContain(source)

    await settle()

    // Gate opened: the formula, no skeleton left behind.
    expect(container.querySelector('.katex')).not.toBeNull()
    expect(container.querySelector('.katex annotation')?.textContent).toBe(source)
    expect(container.querySelector('[data-testid="preview-skeleton"]')).toBeNull()
  })

  it('inline equation shows the INLINE skeleton first, then the formula', async () => {
    const source = String.raw`\frac{a}{b} + \alpha`
    coldRender(StableMathInlinePreview, inlineProps(source))

    // Inline shape, not the 96px block one, so it does not blow up the paragraph.
    expect(container.querySelector('[data-testid="preview-skeleton-inline"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="preview-skeleton"]')).toBeNull()
    expect(container.textContent).not.toContain(source)

    await settle()

    expect(container.querySelector('.katex')).not.toBeNull()
    expect(container.querySelector('.katex annotation')?.textContent).toBe(source)
    expect(container.querySelector('[data-testid="preview-skeleton-inline"]')).toBeNull()
  })

  it('still shows the skeleton, never raw source, with the freeze already on', async () => {
    // The freeze is the closest state to a "cold, paused" first paint; a source
    // that has never rendered in this mount still opens on the skeleton.
    act(() => setPreviewRenderingPaused(true))

    coldRender(StableMathBlockPreview, blockProps('a^2 + b^2 = c^2'))

    expect(container.querySelector('[data-testid="preview-skeleton"]')).not.toBeNull()
    expect(container.textContent).not.toContain('a^2')

    await settle()

    expect(container.querySelector('.katex')).not.toBeNull()
  })
})
