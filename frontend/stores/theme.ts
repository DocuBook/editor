import { create } from 'zustand'
import { isTauri } from '../lib/ipc'

export type ThemeName = 'dark' | 'light'
const STORAGE_KEY = 'docubook:theme'
const THEMES: ThemeName[] = ['dark', 'light']
/** Per-theme browser chrome color (web: address bar / overscroll). */
const META_COLORS: Record<ThemeName, string> = { dark: '#0c0c0d', light: '#ffffff' }

interface ThemeState {
  name: ThemeName
  setTheme: (name: ThemeName) => void
}

/** Named themes — dark + light. The theme name sets <html data-theme="...">,
 *  which index.css maps to the palette; the Tauri window (titlebar) and the
 *  web browser chrome follow along. Persisted to localStorage. */
function applyTheme(name: ThemeName) {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = name
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (meta) meta.content = META_COLORS[name]
  // Tauri native chrome follows the app theme. Per the Tauri docs, on macOS
  // setTheme is app-wide (routes tao → NSApp.appearance); on Windows it
  // drives the native titlebar. window.setTheme is the built-in, documented
  // path — no custom objc needed.
  if (isTauri) {
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(name))
      .catch(() => {})
  }
}

export const useTheme = create<ThemeState>()((set) => ({
  name: readStored(),
  setTheme: (name) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, name)
    applyTheme(name)
    set({ name })
  },
}))

function readStored(): ThemeName {
  if (typeof localStorage === 'undefined') return 'dark'
  const v = localStorage.getItem(STORAGE_KEY)
  return THEMES.includes(v as ThemeName) ? (v as ThemeName) : 'dark'
}

// Apply on boot — module is imported from main.tsx so the palette is set
// before first paint (no dark→light flash for light-theme users). Retry once
// shortly after: at module load the Tauri window may not be visible yet, and
// macOS would otherwise re-apply the system theme on first display.
if (typeof document !== 'undefined') {
  applyTheme(useTheme.getState().name)
  setTimeout(() => applyTheme(useTheme.getState().name), 500)
}
