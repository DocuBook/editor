/** Will focusing an editable raise an on-screen keyboard?
 *
 *  True on a device with a touch input — `any-pointer`, not `pointer`: a phone
 *  with a mouse attached still has the IME, and the question here is whether the
 *  IME EXISTS, not whether touch is the primary pointer. Desktop pointer →
 *  false, so the caret restore there keeps its focus.
 *
 *  Opening a note is reading, not typing: every open restores the caret, but
 *  only a device WITHOUT an on-screen keyboard may claim focus for it. On a
 *  touch device, focusing summons the IME before the reader asked for it, and
 *  the drawer's exit handoff retracts it again on the open that follows a pick
 *  — the keyboard flash reported from a phone. The caret itself is restored
 *  either way; it just stays dormant until the reader taps the page.
 *
 *  `matchMedia` is optional-chained because jsdom has no such object, and a
 *  test environment reads as "no on-screen keyboard" — the desktop behavior
 *  the component tests pin. */
export function softKeyboardOnFocus(): boolean {
  return window.matchMedia?.('(any-pointer: coarse)').matches ?? false
}
