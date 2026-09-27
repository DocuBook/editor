/** BlockNote 0.55's mobile formatting toolbar: portalled into a body-level
 *  container and pinned to the bottom of the *visual* viewport, just above the
 *  on-screen keyboard. On a phone that is the strip the AI composer occupies —
 *  the layout viewport shrinks with the keyboard — so the composer is lifted
 *  clear of it. */
const MOBILE_TOOLBAR_SELECTOR = '.bn-mobile-formatting-toolbar'

/** How far the composer must move up to stay clear of the toolbar, in px.
 *
 *  `anchor` is the box the composer is positioned in (its parent): the composer
 *  rests 20px above that box's bottom edge, and clearing the strip by the same
 *  20px means lifting by however far the strip's top edge reaches above it.
 *  Measured from live rects rather than from the strip's height alone: the
 *  toolbar is pinned to the visual viewport, so what overlaps the composer
 *  changes with the keyboard height and with the visual viewport panning, not
 *  only with the strip's own size.
 *
 *  0 without the strip or before the anchor is mounted. A future BlockNote that
 *  renames the class degrades the same way — the composer merely overlaps
 *  again, it is never mispositioned. */
export function measureMobileToolbarInset(anchor: HTMLElement | null): number {
  if (!anchor) return 0
  const strip = document.querySelector<HTMLElement>(MOBILE_TOOLBAR_SELECTOR)
  if (!strip) return 0
  return Math.max(0, Math.ceil(anchor.getBoundingClientRect().bottom - strip.getBoundingClientRect().top))
}

/** Reports the inset on subscribe and whenever the toolbar appears,
 *  disappears or moves, and whenever the geometry around it changes. Returns
 *  the unsubscribe function.
 *
 *  The observed signals are the ones BlockNote itself repositions the strip on:
 *  it is pinned to the visual viewport, so `visualViewport` resize/scroll can
 *  slide it over the composer without any `window` resize — a taller keyboard,
 *  or iOS panning the viewport to reveal the caret. Listening to `resize` on
 *  `window` alone would keep a stale inset in exactly those cases.
 *
 *  Body's subtree is observed because React mounts the strip inside a portal
 *  container there, and mutations are filtered by node before anything is
 *  measured: ProseMirror rewrites block DOM on every keystroke, and measuring
 *  per mutation would force a layout per keypress. */
export function observeMobileToolbarInset(anchor: () => HTMLElement | null, onChange: (inset: number) => void): () => void {
  let frame = 0
  const schedule = () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      onChange(measureMobileToolbarInset(anchor()))
    })
  }

  const observer = new MutationObserver((records) => {
    const touchesToolbar = records.some((record) =>
      [...record.addedNodes, ...record.removedNodes].some(
        (node) =>
          node instanceof Element &&
          (node.matches(MOBILE_TOOLBAR_SELECTOR) || node.querySelector(MOBILE_TOOLBAR_SELECTOR) !== null),
      ),
    )
    if (touchesToolbar) schedule()
  })
  observer.observe(document.body, { childList: true, subtree: true })

  const viewport = window.visualViewport
  window.addEventListener('resize', schedule)
  viewport?.addEventListener('resize', schedule)
  viewport?.addEventListener('scroll', schedule)

  // A toolbar already up when the composer mounts reports one frame in.
  schedule()

  return () => {
    observer.disconnect()
    window.removeEventListener('resize', schedule)
    viewport?.removeEventListener('resize', schedule)
    viewport?.removeEventListener('scroll', schedule)
    if (frame) cancelAnimationFrame(frame)
  }
}
