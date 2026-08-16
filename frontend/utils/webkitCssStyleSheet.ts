/**
 * Polyfill constructable `CSSStyleSheet` for WKWebView macOS 12 (Safari 15).
 *
 * Safari only made `new CSSStyleSheet()` constructible in 16.4. mermaid calls
 * `new CSSStyleSheet()` unconditionally in `createCssStyles` during every
 * diagram render → on macOS 12 it throws "Illegal constructor" and every
 * diagram shows "Invalid diagram".
 *
 * The polyfill only needs the surface mermaid uses: `insertRule(rule, index)`,
 * `cssRules` (array-like with `.length` and per-rule `.cssText`), and
 * `replaceSync` (guarded by mermaid with `typeof ... === "function"`). Same
 * spirit as iteratorPolyfill.ts: install at startup, guard native availability.
 */
export function installWebkitCssStyleSheet() {
  if (typeof globalThis.CSSStyleSheet !== 'undefined' && typeof globalThis.CSSStyleSheet === 'function') {
    // Native constructible sheets exist (Safari 16.4+/Chrome) — nothing to do.
    try { new (globalThis.CSSStyleSheet as any)(); return } catch {}
  }
  class PolyfillCSSStyleSheet {
    cssRules: { cssText: string }[] = []
    insertRule(rule: string, index = 0): number {
      this.cssRules.splice(index, 0, { cssText: rule })
      return index
    }
    replaceSync(_text: string): void {
      this.cssRules = [{ cssText: _text }]
    }
  }
  Object.defineProperty(globalThis, 'CSSStyleSheet', {
    value: PolyfillCSSStyleSheet,
    writable: true,
    configurable: true,
  })
}
