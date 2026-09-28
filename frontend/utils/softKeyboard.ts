/** Does focusing an editable raise an on-screen keyboard on this system?
 *
 *  A platform question, not a pointer one. `(any-pointer: coarse)` answers "is
 *  there a touch input" — true on every touchscreen laptop, a system whose focus
 *  raises no IME and which then loses the caret restore for nothing. What
 *  decides the IME is the platform: phones and tablets all ship a software
 *  keyboard that focus summons; desktop systems do not summon one from a
 *  programmatic focus, whatever touch hardware they carry.
 *
 *  Opening a note is reading, not typing: every open restores the caret, but
 *  only a system without an on-screen keyboard may claim focus for it. On a
 *  phone, focusing summons the IME before the reader asked for it, and the
 *  drawer's exit handoff retracts it again on the open that follows a pick —
 *  the keyboard flash reported from a phone. The caret itself is restored
 *  either way; it stays dormant until the reader taps the page. */
export function softKeyboardOnFocus(): boolean {
  /* Chromium's client hint reports the PLATFORM, not the requested site: Android
     in desktop-site mode keeps `mobile: true` while its UA stops saying so. */
  const hint = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData
  if (hint?.mobile) return true
  if (/android|iphone|ipad|ipod/i.test(navigator.userAgent)) return true
  /* iPadOS 13+ requests desktop sites by default and reports a "Macintosh" UA;
     a Mac has no touch points, so the count is what tells them apart. */
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}
