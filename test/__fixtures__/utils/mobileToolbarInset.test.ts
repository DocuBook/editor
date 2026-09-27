// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { measureMobileToolbarInset, observeMobileToolbarInset } from '../../../frontend/utils/mobileToolbarInset'

const SELECTOR = '.bn-mobile-formatting-toolbar'

/** Neither box has styles in jsdom (both lay out at 0), so feed the measurement
 *  the rects a browser would report. */
const rect = (top: number, bottom: number) => ({ top, bottom }) as DOMRect

/** The strip sits above the keyboard: `bottom` is the visual viewport's bottom. */
function mountToolbar(box: () => DOMRect) {
  const strip = document.createElement('div')
  strip.className = SELECTOR.slice(1)
  strip.getBoundingClientRect = box
  document.body.appendChild(strip)
  return strip
}

/** The box the composer is positioned in — its bottom edge is the shell's. */
function mountAnchor(bottom: number) {
  const anchor = document.createElement('div')
  anchor.getBoundingClientRect = () => rect(bottom - 100, bottom)
  document.body.appendChild(anchor)
  return anchor
}

/** One animation frame — the observer defers measuring to the next one. */
const frame = () => vi.advanceTimersByTimeAsync(16)

describe('mobile formatting toolbar inset', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.stubGlobal('visualViewport', new EventTarget())
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16))
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('lifts by how far the strip reaches above the anchor, and 0 without it', () => {
    const anchor = mountAnchor(700)
    expect(measureMobileToolbarInset(null)).toBe(0)
    expect(measureMobileToolbarInset(anchor)).toBe(0)

    mountToolbar(() => rect(652, 700))
    expect(measureMobileToolbarInset(anchor)).toBe(48)
  })

  it('does not lift while the strip sits below the composer anchor', () => {
    // The keyboard is short enough that the strip is still clear of the shell's
    // bottom edge: nothing to step over.
    const anchor = mountAnchor(700)
    mountToolbar(() => rect(720, 768))
    expect(measureMobileToolbarInset(anchor)).toBe(0)
  })

  it('reports the inset as the toolbar appears and disappears', async () => {
    const anchor = mountAnchor(700)
    const seen: number[] = []
    const stop = observeMobileToolbarInset(() => anchor, (inset) => seen.push(inset))
    await frame() // the subscribe-time report: no toolbar up yet

    const strip = mountToolbar(() => rect(652, 700))
    await frame()
    strip.remove()
    await frame()
    stop()

    expect(seen).toEqual([0, 48, 0])
  })

  it('re-measures when the strip moves without a window resize', async () => {
    // Regression: the strip is pinned to the visual viewport, so a keyboard
    // height change or an iOS viewport pan slides it over the composer with no
    // `window` resize at all — the inset has to follow the viewport events.
    const anchor = mountAnchor(700)
    let box = rect(652, 700)
    mountToolbar(() => box)
    const seen: number[] = []
    const stop = observeMobileToolbarInset(() => anchor, (inset) => seen.push(inset))
    await frame()

    box = rect(600, 648)
    window.visualViewport!.dispatchEvent(new Event('scroll'))
    await frame()
    window.visualViewport!.dispatchEvent(new Event('resize'))
    await frame()
    stop()

    expect(seen).toEqual([48, 100, 100])
  })

  it('ignores DOM changes that do not touch the toolbar', async () => {
    const anchor = mountAnchor(700)
    const seen: number[] = []
    const stop = observeMobileToolbarInset(() => anchor, (inset) => seen.push(inset))
    await frame()

    // ProseMirror rewrites block DOM on every keystroke; those mutations must
    // not reach the measurement.
    const paragraph = document.createElement('p')
    document.body.appendChild(paragraph)
    paragraph.textContent = 'typed'
    paragraph.remove()
    await frame()
    stop()

    // Only the subscribe-time report — none of those mutations measured.
    expect(seen).toEqual([0])
  })
})
