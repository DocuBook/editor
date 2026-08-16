/**
 * Polyfill `structuredClone` for WKWebView on macOS 12 (Safari 15.0-15.3).
 *
 * Safari added structuredClone in 15.4 — and WKWebView is pinned to the OS
 * version, so macOS 12 ships 15.0-15.3 without it. mermaid 11.x calls
 * structuredClone during diagram render, so every mermaid diagram errors out
 * ("invalid diagram") on those webviews.
 *
 * Implementation: JSON round-trip. StructuredClone semantics differ for
 * Dates, Maps, Sets, ArrayBuffers, RegExps, and cyclic graphs — none of which
 * mermaid passes through this path (it clones plain data objects), so JSON is
 * a safe, dependency-free shim. Same spirit as iteratorPolyfill.ts: install at
 * startup, guard against native availability.
 */
export function installWebkitStructuredClone() {
  if (typeof globalThis.structuredClone === 'function') return
  globalThis.structuredClone = function structuredClone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T
  }
}
