// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mermaid = vi.hoisted(() => ({
  render: vi.fn(),
  trim: vi.fn((svg: string) => svg),
  initializeCalls: 0,
}))

vi.mock('mermaid', () => ({
  default: {
    render: mermaid.render,
  },
}))

vi.mock('@blocknote/core', () => ({
  plainContentToString: (content: unknown) => String(content),
}))

vi.mock('react-icons/si', () => ({ SiMermaid: () => null }))

vi.mock('@blocknote/react', () => ({
  // Renders its label like the real placeholder, so the error path is observable
  // in the DOM rather than only in the props.
  PreviewPlaceholder: ({ text }: { text?: string }) => (text ? <span>{text}</span> : null),
  SourceBlockWithPreview: ({
    preview,
    error,
    errorPreview,
  }: {
    preview?: unknown
    error?: unknown
    errorPreview?: unknown
  }) => (
    <>
      <div data-error={error == null ? '' : String(error)} />
      <div data-has-preview={preview == null ? '' : 'true'} />
      {/* Faithful to the real precedence: an error placeholder, once latched
       *  while the popup is closed, takes the preview's place. */}
      {error != null ? errorPreview ?? null : preview ?? null}
    </>
  ),
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
  initializeMermaid: () => {
    mermaid.initializeCalls += 1
  },
  // Identity transforms keep the assertions about WHICH step ran readable.
  trimDiagramSVG: mermaid.trim,
  withSVGFontFamily: (svg: string) => svg,
}))

import { CachedDiagramPreviewWithPopup } from '../../../frontend/components/editor/CachedDiagramPreview'
import {
  cacheDiagramSVG,
  clearDiagramSVG,
  peekDiagramSVG,
} from '../../../frontend/utils/mermaidRenderCache'

let container: HTMLDivElement
let root: Root
const domElement = document.createElement('div')

/** The font the preview bakes into a cached entry: the document's own computed
 *  style, so a seeded entry is a hit rather than a stale-font miss. */
const documentFont = () => getComputedStyle(domElement).fontFamily

/** Awaited, so the effect's own async render (`mermaid.render` -> trim -> font
 *  rewrite -> `setState`) has settled before the assertions run. */
const renderDiagramNow = (content: string) => {
  act(() => {
    root.render(
      <CachedDiagramPreviewWithPopup
        {...({ block: { content }, editor: { domElement }, contentRef: () => {} } as any)}
      />,
    )
  })
}

const renderDiagram = async (content: string) => {
  await act(async () => {
    renderDiagramNow(content)
  })
}

beforeEach(() => {
  clearDiagramSVG()
  mermaid.render.mockReset()
  mermaid.trim.mockClear()
  mermaid.render.mockImplementation(async (id: string) => ({ svg: `<svg id="${id}"></svg>` }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('CachedDiagramPreviewWithPopup', () => {
  /** The flash fix: a remount (tab switch) must paint the finished diagram from
   *  cache without re-entering Mermaid, `trimDiagramSVG` (forced getBBox reflow)
   *  or the font rewrite. */
  it('paints a cached diagram without re-rendering it', async () => {
    cacheDiagramSVG('graph TD; A-->B', '<svg id="cached"></svg>', documentFont())

    await renderDiagram('graph TD; A-->B')

    expect(mermaid.render).not.toHaveBeenCalled()
    expect(container.innerHTML).toContain('id="cached"')
  })

  it('rewrites cached Mermaid IDs for each preview instance', async () => {
    cacheDiagramSVG(
      'same diagram',
      '<svg id="source-id"><path marker-end="url(#source-id-arrow)"/></svg>',
      documentFont(),
      'source-id',
    )

    await renderDiagram('same diagram')

    const secondContainer = document.createElement('div')
    document.body.appendChild(secondContainer)
    const secondRoot = createRoot(secondContainer)
    await act(async () => {
      secondRoot.render(
        <CachedDiagramPreviewWithPopup
          {...({ block: { content: 'same diagram' }, editor: { domElement }, contentRef: () => {} } as any)}
        />,
      )
    })

    const firstSvg = container.querySelector('svg')
    const secondSvg = secondContainer.querySelector('svg')
    expect(firstSvg?.id).not.toBe(secondSvg?.id)
    expect(firstSvg?.querySelector('path')?.getAttribute('marker-end')).toContain(firstSvg?.id)
    expect(secondSvg?.querySelector('path')?.getAttribute('marker-end')).toContain(secondSvg?.id)
    expect(mermaid.render).not.toHaveBeenCalled()
    act(() => secondRoot.unmount())
    secondContainer.remove()
  })

  it('does not trim a render that became stale before it completed', async () => {
    let resolveOld!: (value: { svg: string }) => void
    mermaid.render.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve }))

    renderDiagramNow('old source')
    await renderDiagram('new source')
    expect(mermaid.trim).toHaveBeenCalledOnce()

    await act(async () => {
      resolveOld({ svg: '<svg id="old"></svg>' })
      await Promise.resolve()
    })

    expect(mermaid.trim).toHaveBeenCalledOnce()
    expect(container.innerHTML).not.toContain('id="old"')
  })

  it('renders on a miss, then caches the finished SVG for the next mount', async () => {
    await renderDiagram('graph TD; A-->B')

    expect(mermaid.render).toHaveBeenCalledOnce()
    expect(mermaid.render.mock.calls[0][1]).toBe('graph TD; A-->B')
    const renderId = mermaid.render.mock.calls[0][0]
    expect(container.innerHTML).toContain('id="mermaid-preview-')
    expect(container.innerHTML).not.toContain(`id="${renderId}"`)
    expect(peekDiagramSVG('graph TD; A-->B')?.renderId).toBe(renderId)
    expect(peekDiagramSVG('graph TD; A-->B')?.svg).toContain(`id="${renderId}"`)
  })

  it('does not cache a diagram that failed to render, and keeps the last good one up', async () => {
    cacheDiagramSVG('good', '<svg id="good"></svg>', documentFont())
    await renderDiagram('good')

    mermaid.render.mockRejectedValue(new Error('invalid'))
    await renderDiagram('broken')

    expect(peekDiagramSVG('broken')).toBeNull()
    // The error placeholder replaces the preview while the popup is closed...
    expect(container.innerHTML).toContain('Invalid diagram')
    // ...but the last good SVG is still held, so opening the popup shows it.
    expect(container.innerHTML).toContain('data-has-preview="true"')
  })

  it('serves the cache again when the source changes back', async () => {
    cacheDiagramSVG('a', '<svg id="a"></svg>', documentFont())
    cacheDiagramSVG('b', '<svg id="b"></svg>', documentFont())

    await renderDiagram('a')
    expect(container.innerHTML).toContain('id="a"')

    await renderDiagram('b')
    expect(container.innerHTML).toContain('id="b"')
    expect(container.innerHTML).not.toContain('id="a"')

    // Both sources came from cache: Mermaid was never asked to render.
    expect(mermaid.render).not.toHaveBeenCalled()
  })
})
