// @vitest-environment jsdom

/** The AI status line's text spinner: one animation per phase, every frame
 *  plain ASCII and of one width, and no ticking under reduced motion. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AsciiLoader } from '../../../frontend/components/editor/AsciiLoader'
import { ASCII_LOADER_FRAMES, type AsciiLoaderKind } from '../../../frontend/components/editor/asciiLoaderFrames'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const reducedMotion = (matches: boolean) =>
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: matches && query.includes('reduce'), media: query })))

describe('AsciiLoader', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    reducedMotion(false)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const loader = () => container.querySelector('.ai-ascii-loader')!
  const render = (kind: AsciiLoaderKind) => act(() => { root.render(<AsciiLoader kind={kind} />) })

  it('draws every kind in printable cells of the slot width', () => {
    for (const [kind, { frames }] of Object.entries(ASCII_LOADER_FRAMES)) {
      expect(frames.length, kind).toBeGreaterThan(1)
      // The slot is 5ch: one width across kinds keeps the label from shifting.
      for (const frame of frames) {
        expect(frame, kind).toHaveLength(5)
        // Printable ASCII, plus the generating wave's `≈`.
        expect(frame, kind).toMatch(/^\[[\x20-\x7e≈]{3}\]$/)
      }
      // Reduced motion shows the first frame alone: it must draw something.
      expect(frames[0], kind).not.toBe('[   ]')
    }
  })

  it('cycles through its frames and wraps around', () => {
    const { frames, interval } = ASCII_LOADER_FRAMES.thinking
    render('thinking')
    const seen = [loader().textContent]
    for (let i = 0; i < frames.length; i++) {
      act(() => { vi.advanceTimersByTime(interval) })
      seen.push(loader().textContent)
    }
    expect(seen).toEqual([...frames, frames[0]])
  })

  it('starts the new animation from its first frame when the kind changes', () => {
    render('generating')
    act(() => { vi.advanceTimersByTime(ASCII_LOADER_FRAMES.generating.interval * 3) })
    render('researching')
    expect(loader().textContent).toBe(ASCII_LOADER_FRAMES.researching.frames[0])
    expect(loader().getAttribute('data-kind')).toBe('researching')
  })

  it('holds still under reduced motion', () => {
    reducedMotion(true)
    render('reasoning')
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(loader().textContent).toBe(ASCII_LOADER_FRAMES.reasoning.frames[0])
  })

  it('is hidden from assistive tech: the label beside it says what is happening', () => {
    render('thinking')
    expect(loader().getAttribute('aria-hidden')).toBe('true')
  })

  it('stops ticking once unmounted', () => {
    render('thinking')
    act(() => root.unmount())
    expect(vi.getTimerCount()).toBe(0)
    root = createRoot(container)
  })
})
