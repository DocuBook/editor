import { create } from 'zustand'
import { isTauri } from '../lib/ipc'

export const THEMES = [
  { id: 'dark', name: 'Midnight', hint: 'Low-light default', colorScheme: 'dark' },
  { id: 'light', name: 'Bright Surfaces', hint: 'Daytime', colorScheme: 'light' },
] as const

export type ThemeName = (typeof THEMES)[number]['id']
export type ThemeColorScheme = (typeof THEMES)[number]['colorScheme']
const STORAGE_KEY = 'docubook:theme'

export function getTheme(name: ThemeName) {
  return THEMES.find(theme => theme.id === name)!
}

interface ThemeState {
  name: ThemeName
  colorScheme: ThemeColorScheme
  setTheme: (name: ThemeName) => void
}

/** Theme id selects app tokens; colorScheme drives libraries and native chrome
 *  that only understand light/dark. Browser chrome reads the active background
 *  token, keeping palette values in index.css instead of duplicating them here. */
function applyTheme(name: ThemeName) {
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
  // drives the native titlebar. window.setTheme is the built-in, documented
  // path — no custom objc needed.
  if (isTauri) {
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(colorScheme))
      .catch(() => {})
  }
}

const initialTheme = readStored()
export const useTheme = create<ThemeState>()((set) => ({
  name: initialTheme,
  colorScheme: getTheme(initialTheme).colorScheme,
  setTheme: (name) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, name)
    applyTheme(name)
    set({ name, colorScheme: getTheme(name).colorScheme })
  },
}))

function readStored(): ThemeName {
  if (typeof localStorage === 'undefined') return 'dark'
  const value = localStorage.getItem(STORAGE_KEY)
  return THEMES.some(theme => theme.id === value) ? value as ThemeName : 'dark'
}

// Apply on boot — module is imported from main.tsx so the palette is set
// before first paint (no dark→light flash for light-theme users). Retry once
// shortly after: at module load the Tauri window may not be visible yet, and
// macOS would otherwise re-apply the system theme on first display.
if (typeof document !== 'undefined') {
  applyTheme(useTheme.getState().name)
  setTimeout(() => applyTheme(useTheme.getState().name), 500)
}
