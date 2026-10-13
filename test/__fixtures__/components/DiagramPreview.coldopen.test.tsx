// @vitest-environment jsdom

/** Cold-open behaviour of the DIAGRAM (mermaid) preview — the flash under test.
 *
 *  The claim to verify: on a first (cold) mount with nothing cached, does the
 *  block paint its raw source text, or a loading placeholder? It must be the
 *  placeholder: `mermaid.render` is asynchronous, so the first paint runs with
 *  `svg === ""` and no error, and `CachedDiagramPreviewWithPopup` must resolve
 *  that to `PreviewSkeleton` (never to bare source text).
 *
 *  This is deliberately a raw-DOM assertion: it looks for the *source text* in
 *  the rendered output, so a regression that reintroduces the raw-text flash
 *  fails here even if the skeleton also happens to be present. */

import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mermaid = vi.hoisted(() => ({ render: vi.fn() }))

vi.mock('mermaid', () => ({ default: { render: mermaid.render } }))
vi.mock('react-icons/si', () => ({ SiMermaid: () => null }))

vi.mock('@mantine/core', () => ({
  Skeleton: ({ 'data-testid': testId }: { 'data-testid'?: string }) => (
    <div data-testid={testId ?? 'skeleton'} />
  ),
}))

vi.mock('@blocknote/core', () => ({
  plainContentToString: (content: unknown) => String(content),
}))

vi.mock('@blocknote/diagram-block', () => ({
  getDiagramDictionary: () => ({
    block: {
      add_source_text: 'Add a Mermaid diagram',
      input_placeholder: 'Enter diagram code',
      preview_error_text: 'Invalid diagram',
      preview_label: 'Mermaid diagram',
    },
  }),
  initializeMermaid: () => {},
  trimDiagramSVG: (svg: string) => svg,
  withSVGFontFamily: (svg: string) => svg,
}))

// The real SourceWithPreview needs a full editor for its popup; the seam under
// test is what `preview` resolves to, so render it directly — same isolation the
// existing CachedDiagramPreview test uses for the caching assertions.
vi.mock('@blocknote/react', () => ({
  PreviewPlaceholder: () => null,
  SourceBlockWithPreview: ({ preview }: { preview?: ReactNode }) => (
    <div data-testid="preview-slot">{preview ?? null}</div>
  ),
}))

import { CachedDiagramPreviewWithPopup } from '../../../frontend/components/editor/CachedDiagramPreview'
import { clearDiagramSVG } from '../../../frontend/utils/mermaidRenderCache'

let container: HTMLDivElement
let root: Root
const domElement = document.createElement('div')

beforeEach(() => {
  clearDiagramSVG()
  mermaid.render.mockReset()
  // Never resolves on its own: keeps the mount in its cold, pre-render state.
  mermaid.render.mockReturnValue(new Promise(() => {}))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const mountCold = async (source: string) => {
  await act(async () => {
    root.render(
      <CachedDiagramPreviewWithPopup
        {...({ block: { content: source }, editor: { domElement }, contentRef: () => {} } as any)}
      />,
    )
  })
}

describe('diagram preview on a cold mount', () => {
  it('shows the skeleton, not the raw source text', async () => {
    const source = 'graph TD; A-->B'
    await mountCold(source)

    expect(container.querySelector('[data-testid="preview-skeleton"]')).not.toBeNull()
    // The whole point: the source must NOT appear as text on screen.
    expect(container.textContent).not.toContain('graph TD')
    expect(container.textContent).not.toContain('A-->B')
  })

  it('does not leak source text through any element while rendering', async () => {
    await mountCold('flowchart LR; Start-->Stop')

    expect(container.textContent).not.toContain('flowchart')
    expect(container.textContent).not.toContain('Start')
  })
})
