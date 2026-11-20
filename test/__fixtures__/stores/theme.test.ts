// @vitest-environment jsdom
/** Theme preference: `system` (the default) follows the OS live; light/dark pin
 *  a theme and are what localStorage keeps. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryStorage } from '../memoryStorage'

let osDark: boolean
let listeners: Set<() => void>
let storage: ReturnType<typeof createMemoryStorage>

/** Fresh module per test: the store reads storage and the OS at import time. */
async function fresh() {
  vi.resetModules()
  return (await import('../../../frontend/stores/theme')).useTheme
}

function setOsDark(dark: boolean) {
  osDark = dark
  for (const listener of listeners) listener()
}

beforeEach(() => {
  osDark = true
  listeners = new Set()
  storage = createMemoryStorage()
  vi.stubGlobal('localStorage', storage.storage)
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    get matches() { return query.includes('dark') && osDark },
    media: query,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  })))
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.theme
})

describe('theme store', () => {
  it('follows the OS by default', async () => {
    osDark = false
    const useTheme = await fresh()

    expect(useTheme.getState().preference).toBe('system')
    expect(useTheme.getState().name).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('switches with the OS while on system', async () => {
    const useTheme = await fresh()
    expect(useTheme.getState().name).toBe('dark')

    setOsDark(false)

    expect(useTheme.getState()).toMatchObject({ name: 'light', colorScheme: 'light' })
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('keeps a pinned theme when the OS changes, and stores only the pin', async () => {
    const useTheme = await fresh()

    useTheme.getState().setTheme('light')
    setOsDark(true)

    expect(useTheme.getState()).toMatchObject({ preference: 'light', name: 'light' })
    expect(storage.values.get('docubook:theme')).toBe('light')

    useTheme.getState().setTheme('system')
    expect(useTheme.getState().name).toBe('dark')
    expect(storage.values.has('docubook:theme')).toBe(false)
  })

  it('restores a stored light/dark as an override, ignoring junk', async () => {
    osDark = true
    storage.values.set('docubook:theme', 'light')
    expect((await fresh()).getState()).toMatchObject({ preference: 'light', name: 'light' })

    storage.values.set('docubook:theme', 'sepia')
    expect((await fresh()).getState()).toMatchObject({ preference: 'system', name: 'dark' })
  })
})
