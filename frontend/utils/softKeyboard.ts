/** Does focusing an editable raise an on-screen keyboard on this system?
 *
 *  A platform question, not a pointer one. `(any-pointer: coarse)` answers "is
 *  there a touch input" — true on every touchscreen laptop, a system whose focus
 *  raises no IME and which then loses the caret restore for nothing. What
 *  decides the IME is the platform: phones and tablets all ship a software
 *  keyboard that focus summons; desktop systems do not summon one from a
 *  programmatic focus, whatever touch hardware they carry.
 *
 *  Four signals, each closing a hole the one above it leaves open:
 *  1. Chromium's client hint reports the platform, not the requested site, so
 *     Android in desktop-site mode stays `mobile: true` while its UA does not.
 *  2. Engines without client hints at least keep a mobile UA token — iPhone
 *     keeps its `Mobile` token even in desktop-site mode.
 *  3. iPadOS requests desktop sites by default and says "Macintosh"; a Mac has
 *     no touch points, so the count is what still identifies it.
 *  4. Firefox on Android hides even the token (its desktop-site mode reports a
 *     plain desktop UA and exposes no hints). Hardware is what is left: Android
 *     runs on an ARM Linux, and a handset — the device class whose focus raises
 *     an IME — measures no more than ~500 CSS px on its short side, far below
 *     the smallest laptop panel (720). A desktop-class touch screen fails this
 *     test on purpose: it keeps its caret restore. An Android TABLET in the
 *     same disguise still slips through — its short side matches a small
 *     laptop's, and no signal separates the two.
 *
 *  Opening a note is reading, not typing: every open restores the caret, but
 *  only a system without an on-screen keyboard may claim focus for it. On a
 *  phone, focusing summons the IME before the reader asked for it, and the
 *  drawer's exit handoff retracts it again on the open that follows a pick —
 *  the keyboard flash reported from a phone. The caret itself is restored
 *  either way; it stays dormant until the reader taps the page. */
export function softKeyboardOnFocus(): boolean {
  const hint = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData
  if (hint?.mobile) return true
  if (/android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent)) return true
  if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true
  /* Signal 4 needs touch to be a handset question at all: a narrow screen
     without one is a small laptop, which has no IME to raise. `> 0` rather than
     `!== 0` on purpose — a browser that cannot report touch at all (jsdom,
     where the property is missing) must not read as a handset either. */
  if (!(navigator.maxTouchPoints > 0)) return false
  return /^linux (arm|aarch64)/i.test(navigator.platform)
    /* Same for the screen: 0×0 is "not reported", not "tiny". */
    || (screen.width > 0 && Math.min(screen.width, screen.height) <= 700)
}
