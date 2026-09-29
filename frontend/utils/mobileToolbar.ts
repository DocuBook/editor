/** BlockNote 0.55's mobile formatting toolbar: portalled into a body-level
 *  container and pinned to the bottom of the *visual* viewport, just above the
 *  on-screen keyboard. On a phone it is the strip the AI composer occupies, and
 *  BlockNote gates it on the keyboard being open AND the editor holding focus —
 *  so while it is up the reader is editing the document, not the composer, and
 *  the composer collapses instead of floating over the strip. */
const MOBILE_TOOLBAR_SELECTOR = '.bn-mobile-formatting-toolbar'

/** Reports whether the toolbar is up on subscribe and whenever it appears or
 *  disappears. Returns the unsubscribe function.
 *
 *  Only the toolbar node's comings and goings are observed: React mounts the
 *  strip inside a portal container on `document.body`, and mutations are
 *  filtered by node before anything is read — ProseMirror rewrites block DOM on
 *  every keystroke, and resolving the selector per mutation would force a query
 *  per keypress. A future BlockNote that renames the class degrades to a
 *  composer that stays put, never to a mispositioned one. */
export function observeMobileToolbar(onChange: (up: boolean) => void): () => void {
  const read = () => document.querySelector(MOBILE_TOOLBAR_SELECTOR) !== null

  const observer = new MutationObserver((records) => {
    const touchesToolbar = records.some((record) =>
      /* Array.from: NodeList is only iterable in lib.dom.iterable, which this
         project's lib set does not include — and spreading it needs one. */
      [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some(
        (node) =>
          node instanceof Element &&
          (node.matches(MOBILE_TOOLBAR_SELECTOR) || node.querySelector(MOBILE_TOOLBAR_SELECTOR) !== null),
      ),
    )
    if (touchesToolbar) onChange(read())
  })
  observer.observe(document.body, { childList: true, subtree: true })

  // A toolbar already up when the composer mounts reports on subscribe.
  onChange(read())

  return () => observer.disconnect()
}
