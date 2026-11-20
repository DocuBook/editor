// @vitest-environment jsdom
/** Font-size overrides: px on `--user-font-<level>` (index.css falls back to its
 *  default when unset), kept in localStorage, defaults read from the CSS. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryStorage } from '../memoryStorage'

let storage: ReturnType<typeof createMemoryStorage>
const cssVar = (name: string) => document.documentElement.style.getPropertyValue(name)

async function fresh() {
  vi.resetModules()
  return await import('../../../frontend/stores/typography')
}

beforeEach(() => {
  storage = createMemoryStorage()
  vi.stubGlobal('localStorage', storage.storage)
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('style')
})

describe('typography store', () => {
  it('applies, persists and clears an override', async () => {
    const { useTypography } = await fresh()

    useTypography.getState().setSize('heading-1', 32)
    expect(cssVar('--user-font-heading-1')).toBe('32px')
    expect(JSON.parse(storage.values.get('docubook:font-sizes')!)).toEqual({ 'heading-1': 32 })

    useTypography.getState().setSize('heading-1', undefined)
    expect(cssVar('--user-font-heading-1')).toBe('')
    expect(storage.values.has('docubook:font-sizes')).toBe(false)
  })

  it('treats an out-of-range size as no override', async () => {
    const { useTypography, MAX_FONT_PX } = await fresh()

    useTypography.getState().setSize('paragraph', MAX_FONT_PX + 1)

    expect(useTypography.getState().sizes).toEqual({})
    expect(cssVar('--user-font-paragraph')).toBe('')
  })

  it('reset drops every override', async () => {
    const { useTypography } = await fresh()
    useTypography.getState().setSize('heading-2', 24)
    useTypography.getState().setSize('paragraph', 18)

    useTypography.getState().reset()

    expect(useTypography.getState().sizes).toEqual({})
    expect(cssVar('--user-font-heading-2') + cssVar('--user-font-paragraph')).toBe('')
  })

  it('restores valid stored sizes on boot and drops the rest', async () => {
    storage.values.set('docubook:font-sizes', JSON.stringify({ 'heading-3': 20, paragraph: 'big', 'heading-9': 40, 'heading-1': 2 }))

    const { useTypography } = await fresh()

    expect(useTypography.getState().sizes).toEqual({ 'heading-3': 20 })
    expect(cssVar('--user-font-heading-3')).toBe('20px')
  })

  it('reads heading defaults from the CSS variable, in px of the 16px editor base', async () => {
    const { defaultFontPx } = await fresh()
    document.documentElement.style.setProperty('--heading-1-default', '2.25em')
    document.documentElement.style.setProperty('--heading-3-default', '1.1875em')

    expect(defaultFontPx('heading-1')).toBe(36)
    expect(defaultFontPx('heading-3')).toBe(19)
    expect(defaultFontPx('paragraph')).toBe(16)
  })
})
