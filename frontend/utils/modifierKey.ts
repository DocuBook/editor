import { isMacTauri } from '../lib/ipc'

/** Whether the OS uses ⌘ as its primary shortcut key. Desktop reads the build
 *  target; the web build reads the browser, preferring `userAgentData` (the
 *  non-deprecated source) and falling back to `navigator.platform`. */
export function isApplePlatform(): boolean {
  if (isMacTauri) return true
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform || nav.platform || '')
}

/** Label for the click that follows a link or wikilink. Both Cmd and Ctrl work
 *  everywhere (see wikilinkStyler); the label names the one that fits the OS. */
export function modifierClickLabel(): string {
  return isApplePlatform() ? 'Cmd+Click' : 'Ctrl+Click'
}
