import { create } from 'zustand'
import { isTauri } from '../lib/ipc'

export const THEMES = [
  { id: 'dark', name: 'Midnight', hint: 'Low-light default', colorScheme: 'dark' },
  { id: 'light', name: 'Bright Surfaces', hint: 'Daytime', colorScheme: 'light' },
] as const

export type ThemeName = (typeof THEMES)[number]['id']
export type ThemeColorScheme = (typeof THEMES)[number]['colorScheme']
/** What the user picked: follow the OS, or pin one of the themes. */
export type ThemePreference = 'system' | ThemeName
const STORAGE_KEY = 'docubook:theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

export function getTheme(name: ThemeName) {
  return THEMES.find(theme => theme.id === name)!
}

/** The theme `system` stands for right now. */
function systemTheme(): ThemeName {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark'
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

const resolve = (preference: ThemePreference): ThemeName => preference === 'system' ? systemTheme() : preference

interface ThemeState {
  preference: ThemePreference
  /** The applied theme (`preference`, with `system` resolved). */
  name: ThemeName
  colorScheme: ThemeColorScheme
  setTheme: (preference: ThemePreference) => void
}

/** Theme id selects app tokens; colorScheme drives libraries and native chrome
 *  that only understand light/dark. Browser chrome reads the active background
 *  token, keeping palette values in index.css instead of duplicating them here. */
function applyTheme(preference: ThemePreference, name: ThemeName) {
  if (typeof document === 'undefined') return
  const { colorScheme } = getTheme(name)
  const root = document.documentElement
  root.dataset.theme = name
  root.style.colorScheme = colorScheme
  const background = getComputedStyle(root).getPropertyValue('--color-background').trim()
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (meta && background) meta.content = background
  // Tauri native chrome follows the app theme. Per the Tauri docs, on macOS
  // setTheme is app-wide (routes tao → NSApp.appearance); on Windows it
  // drives the native titlebar. `null` releases the pin for `system`: a pinned
  // appearance would also pin the webview's prefers-color-scheme, and the app
  // could never see the OS change again.
  if (isTauri) {
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(preference === 'system' ? null : colorScheme))
      .catch(() => {})
  }
}

const initialPreference = readStored()
const initialName = resolve(initialPreference)
export const useTheme = create<ThemeState>()((set) => ({
  preference: initialPreference,
  name: initialName,
  colorScheme: getTheme(initialName).colorScheme,
  setTheme: (preference) => {
    if (typeof localStorage !== 'undefined') {
      if (preference === 'system') localStorage.removeItem(STORAGE_KEY)
      else localStorage.setItem(STORAGE_KEY, preference)
    }
    const name = resolve(preference)
    applyTheme(preference, name)
    set({ preference, name, colorScheme: getTheme(name).colorScheme })
  },
}))

/** A stored light/dark is an explicit override; nothing stored means `system`. */
function readStored(): ThemePreference {
  if (typeof localStorage === 'undefined') return 'system'
  const value = localStorage.getItem(STORAGE_KEY)
  return THEMES.some(theme => theme.id === value) ? value as ThemeName : 'system'
}

// Apply on boot — module is imported from main.tsx so the palette is set
// before first paint (no dark→light flash for light-theme users). Retry once
// shortly after: at module load the Tauri window may not be visible yet, and
// macOS would otherwise re-apply the system theme on first display.
if (typeof document !== 'undefined') {
  const reapply = () => {
    const { preference } = useTheme.getState()
    const name = resolve(preference)
    applyTheme(preference, name)
    if (name !== useTheme.getState().name) useTheme.setState({ name, colorScheme: getTheme(name).colorScheme })
  }
  reapply()
  setTimeout(reapply, 500)
  // `system` tracks the OS live; a pinned theme ignores it.
  window.matchMedia?.(DARK_QUERY).addEventListener?.('change', () => {
    if (useTheme.getState().preference === 'system') reapply()
  })
}
