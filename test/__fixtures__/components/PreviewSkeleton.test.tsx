// @vitest-environment jsdom

/** The single loading placeholder for source-backed previews. Pinned as a
 *  contract because the diagram preview depends on its exact reserved height
 *  (a wrong height would shift the block when the async render lands), and
 *  because "one place" only holds if this is what the previews actually render.
 *  Uses the REAL Mantine `Skeleton` (not a stub) so the rendered attributes are
 *  the ones the app ships. */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
// Mantine's provider reads the OS colour scheme, which jsdom has no matchMedia for.
Object.assign(window, {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }),
})

import { PreviewSkeleton } from '../../../frontend/components/editor/PreviewSkeleton'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('PreviewSkeleton', () => {
  it('reserves a 96px animated block', async () => {
    await act(async () => {
      root.render(
        <MantineProvider>
          <PreviewSkeleton />
        </MantineProvider>,
      )
    })

    const skeleton = container.querySelector<HTMLElement>('[data-testid="preview-skeleton"]')
    expect(skeleton).not.toBeNull()
    // Mantine exposes the size as a rem CSS variable on the root element
    // (scaled by --mantine-scale), not as an inline height, so assert the
    // variable the app actually ships: 96px -> 6rem.
    expect(skeleton!.style.getPropertyValue('--skeleton-height')).toBe('calc(6rem * var(--mantine-scale))')
  })

  it('inline variant is line-height sized and stays on the text baseline', async () => {
    await act(async () => {
      root.render(
        <MantineProvider>
          <PreviewSkeleton inline />
        </MantineProvider>,
      )
    })

    // A distinct testid, so an inline equation can never be mistaken for a block
    // one: the block 96px height would blow the paragraph open.
    const skeleton = container.querySelector<HTMLElement>('[data-testid="preview-skeleton-inline"]')
    expect(skeleton).not.toBeNull()
    expect(container.querySelector('[data-testid="preview-skeleton"]')).toBeNull()
    // 14px -> 0.875rem, and it must not claim a block's box.
    expect(skeleton!.style.getPropertyValue('--skeleton-height')).toBe('calc(0.875rem * var(--mantine-scale))')
    expect(skeleton!.style.display).toBe('inline-block')
  })
})
