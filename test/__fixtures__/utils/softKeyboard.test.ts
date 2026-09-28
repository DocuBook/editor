// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { softKeyboardOnFocus } from '../../../frontend/utils/softKeyboard'

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
const IPAD_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
/** Firefox for Android in desktop-site mode: a plain desktop UA, no client hints. */
const FIREFOX_DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0'

/** The signals the predicate reads are getters on jsdom's navigator and screen;
 *  shadowing them per test and dropping the shadows restores the environment. */
function signals({ userAgent, platform = '', maxTouchPoints = 0, uaDataMobile, screen }: {
  userAgent: string; platform?: string; maxTouchPoints?: number; uaDataMobile?: boolean; screen?: { width: number; height: number }
}) {
  Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true })
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true })
  Object.defineProperty(window.navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true })
  if (uaDataMobile !== undefined) Object.defineProperty(window.navigator, 'userAgentData', { value: { mobile: uaDataMobile }, configurable: true })
  if (screen) {
    Object.defineProperty(window.screen, 'width', { value: screen.width, configurable: true })
    Object.defineProperty(window.screen, 'height', { value: screen.height, configurable: true })
  }
}

afterEach(() => {
  for (const property of ['userAgent', 'platform', 'maxTouchPoints', 'userAgentData']) {
    Reflect.deleteProperty(window.navigator, property)
  }
  for (const property of ['width', 'height']) Reflect.deleteProperty(window.screen, property)
})

describe('softKeyboardOnFocus', () => {
  it('reads a phone as a system whose focus raises the IME', () => {
    signals({ userAgent: IPHONE_UA })
    expect(softKeyboardOnFocus()).toBe(true)
  })

  it('reads Android the same way', () => {
    signals({ userAgent: ANDROID_UA })
    expect(softKeyboardOnFocus()).toBe(true)
  })

  /** iPadOS asks for the desktop site by default, so its UA says Macintosh —
   *  the touch points are what still identify the platform. */
  it('reads iPadOS behind its desktop-site UA', () => {
    signals({ userAgent: IPAD_DESKTOP_UA, platform: 'MacIntel', maxTouchPoints: 2 })
    expect(softKeyboardOnFocus()).toBe(true)
  })

  /** The client hint survives the desktop-site request the UA does not. */
  it('trusts the platform hint when a phone hides behind a desktop UA', () => {
    signals({ userAgent: DESKTOP_UA, uaDataMobile: true })
    expect(softKeyboardOnFocus()).toBe(true)
  })

  /** Desktop-site mode on Firefox: no hint, no token — the ARM Linux Android
   *  runs on is still reported. */
  it('reads an Android platform that gave up its UA token', () => {
    signals({ userAgent: FIREFOX_DESKTOP_UA, platform: 'Linux armv8l', maxTouchPoints: 1 })
    expect(softKeyboardOnFocus()).toBe(true)
  })

  /** …and when even the platform is disguised, a handset-shaped touch screen is
   *  what is left (landscape: the short side is the one that matters). */
  it('reads a handset-shaped touch screen with every platform signal hidden', () => {
    signals({ userAgent: FIREFOX_DESKTOP_UA, platform: 'Win32', maxTouchPoints: 1, screen: { width: 915, height: 412 } })
    expect(softKeyboardOnFocus()).toBe(true)
  })

  /** Touch availability is not IME behavior: this system raises no keyboard on
   *  focus, and withholding the caret restore here would lose it for nothing. */
  it('keeps the caret restore on a touchscreen desktop', () => {
    signals({ userAgent: DESKTOP_UA, platform: 'Win32', maxTouchPoints: 10, screen: { width: 1440, height: 900 } })
    expect(softKeyboardOnFocus()).toBe(false)
  })

  /** A narrow desktop screen without touch is a small laptop, not a handset. */
  it('keeps the caret restore on a narrow screen without touch', () => {
    signals({ userAgent: DESKTOP_UA, platform: 'Win32', screen: { width: 1024, height: 600 } })
    expect(softKeyboardOnFocus()).toBe(false)
  })

  it('reads a plain desktop (and jsdom) as no on-screen keyboard', () => {
    expect(softKeyboardOnFocus()).toBe(false)
  })
})
