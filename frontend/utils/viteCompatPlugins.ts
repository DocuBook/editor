/**
 * Vite/Vitest compat transforms — SINGLE source of truth.
 *
 * Both vite.config.ts and vitest.config.ts must apply these patches to the
 * @blocknote/@tiptap bundles (in dev, build, and test), so they are defined
 * HERE once and imported by both configs — never re-implemented per file.
 *
 * Why they exist, briefly:
 *  - tiptapViewProxyCompat: tiptap's `get view()` returns a Proxy that THROWS
 *    on property access (`domAtPos`) when the editor view is not mounted.
 *    Keep-alive tabs can re-render a detached view (BlockPopover/useMemo, AI
 *    auto-scroll), and the throw lands in React's render phase → error
 *    boundary crash. Patch the proxy to return a safe placeholder for
 *    `domAtPos` (undefined node + no-op scrollIntoView) instead of throwing.
 *  - blocknoteMathWhitespaceCompat: BlockNote's HTML whitespace normalizer
 *    collapses newlines inside <math><annotation> into spaces, breaking
 *    multiline LaTeX. Add MATH/ANNOTATION to its whitespace-preserve set so
 *    aligned environments survive the round-trip.
 *
 * Hard-failure guards: both patches target minified-ish vendor bundles via
 * marker strings. If an upgrade changes the bundle shape, a silent miss would
 * ship an UNPATCHED build (the exact failure class that killed the domAtPos
 * patch once: @tiptap/core 3.30.5 rewrote the proxy to a one-line form the
 * old brace pattern no longer matched). Each transform therefore throws when
 * its target file is identified but the expected pattern is missing — the
 * build fails loudly instead of regressing quietly.
 *
 * Applied at optimizeDeps.rolldownOptions.plugins (vite) / top-level plugins
 * (vitest) so the patched code lands in the pre-bundle and test transform
 * pipeline. Fix here, not in node_modules (doesn't survive npm ci).
 */
import type { Plugin } from 'vite'

/** Unique marker of BlockNote's HTML whitespace normalizer (the only chunk
 *  carrying this regex) — distinguishes "vendor bundle changed" from "not the
 *  target file", so the guard never fires on unrelated @blocknote chunks. */
const WHITESPACE_MARKER = '[ \\t\\r\\n\\f]+'
/** ESM chunk (src-*.js) and CJS chunk (src-*.cjs) spell the Set differently. */
const WHITESPACE_SET_ESM = 'new Set(["PRE", "CODE"])'
const WHITESPACE_SET_CJS = 'new Set([`PRE`,`CODE`])'
const WHITESPACE_SET_PATCH_ESM = 'new Set(["PRE", "CODE", "MATH", "ANNOTATION", "math", "annotation"])'
const WHITESPACE_SET_PATCH_CJS = 'new Set([`PRE`,`CODE`,`MATH`,`ANNOTATION`,`math`,`annotation`])'

export function blocknoteMathWhitespaceCompat(): Plugin {
  return {
    name: 'blocknote-math-whitespace-compat',
    transform(code, id) {
      if (!id.includes('/@blocknote/core/dist/')) return
      if (!code.includes(WHITESPACE_MARKER)) return
      if (code.includes(WHITESPACE_SET_ESM)) {
        return code.replace(WHITESPACE_SET_ESM, WHITESPACE_SET_PATCH_ESM)
      }
      if (code.includes(WHITESPACE_SET_CJS)) {
        return code.replace(WHITESPACE_SET_CJS, WHITESPACE_SET_PATCH_CJS)
      }
      throw new Error(
        `[viteCompatPlugins] blocknoteMathWhitespaceCompat: found the whitespace normalizer in ${id} but neither Set pattern matched. ` +
          'The @blocknote/core bundle changed — update WHITESPACE_SET_ESM/CJS in frontend/utils/viteCompatPlugins.ts before this build can succeed.',
      )
    },
  }
}

/** Unique marker of tiptap's detached-view error (only in the Editor `view`
 *  getter of @tiptap/core's dist entry, js + cjs). */
const VIEW_PROXY_MARKER = 'Cannot access view'
/** @tiptap/core ≥3.30: one-line proxy form. The `(\s*)` capture reuses the
 *  surrounding whitespace so the inserted guard keeps the bundle's indentation. */
const VIEW_PROXY_PATTERN = /if \(key in obj\) return Reflect\.get\(obj, key\);(\s*)throw new Error\(/

export function tiptapViewProxyCompat(): Plugin {
  return {
    name: 'tiptap-view-proxy-compat',
    transform(code, id) {
      if (!id.includes('/@tiptap/core/dist/')) return
      if (!code.includes(VIEW_PROXY_MARKER)) return
      const match = code.match(VIEW_PROXY_PATTERN)
      if (!match) {
        throw new Error(
          `[viteCompatPlugins] tiptapViewProxyCompat: found the detached-view error in ${id} but the proxy pattern no longer matches. ` +
            'The @tiptap/core bundle changed — update VIEW_PROXY_PATTERN in frontend/utils/viteCompatPlugins.ts before this build can succeed.',
        )
      }
      const ws = match[1]
      return code.replace(
        VIEW_PROXY_PATTERN,
        `if (key in obj) return Reflect.get(obj, key);${ws}if (key === "domAtPos") return () => ({ node: { scrollIntoView() {} }, text: undefined });${ws}throw new Error(`,
      )
    },
  }
}