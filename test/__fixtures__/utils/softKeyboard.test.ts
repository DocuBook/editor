// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { softKeyboardOnFocus } from '../../../frontend/utils/softKeyboard'

const originalMatchMedia = window.matchMedia

function stubMatchMedia(coarse: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: coarse && query.includes('coarse'),
    media: query,
    onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

afterEach(() => { window.matchMedia = originalMatchMedia })

describe('softKeyboardOnFocus', () => {
  it('reads a touch input as an on-screen keyboard', () => {
    stubMatchMedia(true)
    expect(softKeyboardOnFocus()).toBe(true)
  })

  it('is false on a pointer without touch', () => {
    stubMatchMedia(false)
    expect(softKeyboardOnFocus()).toBe(false)
  })

  /** jsdom ships no matchMedia. The fallback must stay the desktop reading: the
   *  component tests that pin focus-at-open run in that environment. */
  it('falls back to no on-screen keyboard where matchMedia is missing', () => {
    Reflect.deleteProperty(window, 'matchMedia')
    expect(softKeyboardOnFocus()).toBe(false)
  })
})
