// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { softKeyboardOnFocus } from '../../../frontend/utils/softKeyboard'

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
const IPAD_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
const TOUCH_LAPTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** The signals the predicate reads are prototype getters on a jsdom navigator;
 *  shadowing them per test and dropping the shadows restores the environment. */
function signals({ userAgent, platform = '', maxTouchPoints = 0, uaDataMobile }: {
  userAgent: string; platform?: string; maxTouchPoints?: number; uaDataMobile?: boolean
}) {
  Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true })
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true })
  Object.defineProperty(window.navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true })
  if (uaDataMobile !== undefined) Object.defineProperty(window.navigator, 'userAgentData', { value: { mobile: uaDataMobile }, configurable: true })
}

afterEach(() => {
  for (const property of ['userAgent', 'platform', 'maxTouchPoints', 'userAgentData']) {
    Reflect.deleteProperty(window.navigator, property)
  }
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
    signals({ userAgent: TOUCH_LAPTOP_UA, uaDataMobile: true })
    expect(softKeyboardOnFocus()).toBe(true)
  })

  /** Touch availability is not IME behavior: this system raises no keyboard on
   *  focus, and withholding the caret restore here would lose it for nothing. */
  it('keeps the caret restore on a touchscreen desktop', () => {
    signals({ userAgent: TOUCH_LAPTOP_UA, maxTouchPoints: 10 })
    expect(softKeyboardOnFocus()).toBe(false)
  })

  it('reads a plain desktop (and jsdom) as no on-screen keyboard', () => {
    expect(softKeyboardOnFocus()).toBe(false)
  })
})
