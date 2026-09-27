// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { measureMobileToolbarInset, observeMobileToolbarInset } from '../../../frontend/utils/mobileToolbarInset'

const SELECTOR = '.bn-mobile-formatting-toolbar'

/** The strip is styled by BlockNote, so jsdom lays it out at 0px — feed the
 *  measurement the height a browser would report. */
function mountToolbar(height: () => number) {
  const strip = document.createElement('div')
  strip.className = SELECTOR.slice(1)
  strip.getBoundingClientRect = () => ({ height: height() }) as DOMRect
  document.body.appendChild(strip)
  return strip
}

/** One animation frame — the observer defers measuring to the next one. */
const frame = () => vi.advanceTimersByTimeAsync(16)

describe('mobile formatting toolbar inset', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16))
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('measures 0 without the toolbar and the strip height with it', () => {
    expect(measureMobileToolbarInset()).toBe(0)
    mountToolbar(() => 48)
    expect(measureMobileToolbarInset()).toBe(48)
  })

  it('reports the inset as the toolbar appears and disappears', async () => {
    const seen: number[] = []
    const stop = observeMobileToolbarInset((inset) => seen.push(inset))

    const strip = mountToolbar(() => 48)
    await frame()
    strip.remove()
    await frame()
    stop()

    expect(seen).toEqual([48, 0])
  })

  it('re-measures while the toolbar stays mounted', async () => {
    let height = 48
    mountToolbar(() => height)
    const seen: number[] = []
    const stop = observeMobileToolbarInset((inset) => seen.push(inset))

    height = 80
    window.dispatchEvent(new Event('resize'))
    await frame()
    stop()

    expect(seen).toEqual([80])
  })

  it('ignores DOM changes that do not touch the toolbar', async () => {
    const seen: number[] = []
    const stop = observeMobileToolbarInset((inset) => seen.push(inset))

    // ProseMirror rewrites block DOM on every keystroke; those mutations must
    // not reach the measurement.
    const paragraph = document.createElement('p')
    document.body.appendChild(paragraph)
    paragraph.textContent = 'typed'
    paragraph.remove()
    await frame()
    stop()

    expect(seen).toEqual([])
  })
})
