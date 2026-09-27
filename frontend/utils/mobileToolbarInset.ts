/** BlockNote 0.55's mobile formatting toolbar: portalled into a body-level
 *  container and pinned to the bottom of the visual viewport, just above the
 *  on-screen keyboard. On a phone that is the same strip the AI composer
 *  occupies — the layout viewport shrinks with the keyboard — so the composer
 *  is lifted by this inset while the toolbar is on screen. */
const MOBILE_TOOLBAR_SELECTOR = '.bn-mobile-formatting-toolbar'

/** Height of the mobile formatting toolbar, or 0 when it is not rendered.
 *
 *  Presence is the signal: the toolbar controller mounts the strip only while
 *  it is shown (touch device + virtual keyboard + editor focus), so an element
 *  in the document means the toolbar is on screen. Measuring beats a constant
 *  because the strip's height follows the safe-area inset and the skin's own
 *  button size, and a renamed class would degrade to 0 — the composer merely
 *  overlaps again, it is never mispositioned. */
export function measureMobileToolbarInset(): number {
  const strip = document.querySelector<HTMLElement>(MOBILE_TOOLBAR_SELECTOR)
  return strip ? Math.ceil(strip.getBoundingClientRect().height) : 0
}

/** Reports the inset whenever the toolbar appears, disappears, or changes
 *  height (a rotation or safe-area change can resize it while it stays
 *  mounted). Returns the unsubscribe function.
 *
 *  Body's subtree is observed because React mounts the strip inside a portal
 *  container there, and mutations are filtered by node before anything is
 *  measured: ProseMirror rewrites block DOM on every keystroke, and measuring
 *  per mutation would force a layout per keypress. */
export function observeMobileToolbarInset(onChange: (inset: number) => void): () => void {
  let frame = 0
  const schedule = () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      onChange(measureMobileToolbarInset())
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
  window.addEventListener('resize', schedule)

  return () => {
    observer.disconnect()
    window.removeEventListener('resize', schedule)
    if (frame) cancelAnimationFrame(frame)
  }
}
