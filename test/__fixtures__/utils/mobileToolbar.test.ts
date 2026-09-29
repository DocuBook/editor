// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { observeMobileToolbar } from '../../../frontend/utils/mobileToolbar'

const SELECTOR = '.bn-mobile-formatting-toolbar'

/** BlockNote mounts the strip into a body-level portal, above the keyboard. */
function mountToolbar(parent: HTMLElement = document.body) {
  const strip = document.createElement('div')
  strip.className = SELECTOR.slice(1)
  parent.appendChild(strip)
  return strip
}

/** MutationObserver delivers on a microtask; let it land. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('mobile formatting toolbar presence', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('reports the toolbar as it appears and disappears', async () => {
    const seen: boolean[] = []
    const stop = observeMobileToolbar((up) => seen.push(up))

    const strip = mountToolbar()
    await tick()
    strip.remove()
    await tick()
    stop()

    expect(seen).toEqual([false, true, false])
  })

  it('reports a toolbar already up at subscribe', async () => {
    mountToolbar()
    const seen: boolean[] = []
    const stop = observeMobileToolbar((up) => seen.push(up))
    await tick()
    stop()

    expect(seen).toEqual([true])
  })

  it('sees a strip that arrives inside a portal container', async () => {
    // React renders the strip inside a container mounted on body, so the added
    // node is the container, not the strip itself.
    const seen: boolean[] = []
    const stop = observeMobileToolbar((up) => seen.push(up))

    const container = document.createElement('div')
    mountToolbar(container)
    document.body.appendChild(container)
    await tick()
    stop()

    expect(seen).toEqual([false, true])
  })

  it('stops reporting once unsubscribed', async () => {
    const seen: boolean[] = []
    const stop = observeMobileToolbar((up) => seen.push(up))
    stop()

    mountToolbar()
    await tick()

    expect(seen).toEqual([false])
  })

  it('ignores DOM changes that do not touch the toolbar', async () => {
    const seen: boolean[] = []
    const stop = observeMobileToolbar((up) => seen.push(up))

    // ProseMirror rewrites block DOM on every keystroke; those mutations must
    // not reach the observer.
    const paragraph = document.createElement('p')
    document.body.appendChild(paragraph)
    paragraph.textContent = 'typed'
    paragraph.remove()
    await tick()
    stop()

    // Only the subscribe-time report — none of those mutations counted.
    expect(seen).toEqual([false])
  })
})
