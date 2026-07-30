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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
)
