// Polyfill ES2023 array methods for Safari < 16.4 (macOS 12 Monterey)
/** @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/toReversed */
if (!Array.prototype.toReversed) {
  Array.prototype.toReversed = function<T>(): T[] { return [...this].reverse() }
}
/** @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/toSorted */
if (!Array.prototype.toSorted) {
  Array.prototype.toSorted = function<T>(fn?: (a: T, b: T) => number): T[] { return [...this].sort(fn) }
}
/** @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/toSpliced */
if (!Array.prototype.toSpliced) {
  Array.prototype.toSpliced = function<T>(start: number, deleteCount?: number, ...items: T[]): T[] {
    return [...this.slice(0, start), ...items, ...this.slice(start + (deleteCount ?? 0))]
  }
}

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { installGlobalErrorHandlers } from './utils/logger'
import './stores/theme' // applies <html data-theme> before first paint
import { installIteratorFilterPolyfill } from './utils/iteratorPolyfill'
installIteratorFilterPolyfill()
// WKWebView macOS 12 lacks structuredClone (Safari 15.4+) — see polyfill file.
import { installWebkitStructuredClone } from './utils/webkitStructuredClone'
installWebkitStructuredClone()
// WKWebView macOS 12 can't construct CSSStyleSheet (Safari 16.4+) — mermaid
// needs it to render. See polyfill file.
import { installWebkitCssStyleSheet } from './utils/webkitCssStyleSheet'
installWebkitCssStyleSheet()
installGlobalErrorHandlers()

// NOTE: no Object.prototype hardening here. Tauri's freezePrototype broke
// zod/xl-ai (they assign Object.prototype.toString during module eval), and
// freezing __proto__ breaks rope-sequence (prosemirror dep used by xl-ai,
// does `Child.__proto__ = Parent` inheritance) — so any Object.prototype
// mutation kills the AI stack. Prototype-pollution protection belongs at
// input boundaries (JSON.parse reviver), not on built-in prototypes.

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary><App /></ErrorBoundary>
  </React.StrictMode>,
)
