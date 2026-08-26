/**
 * Vite/Vitest compat transforms — SINGLE source of truth.
 *
 * Both vite.config.ts and vitest.config.ts must apply these patches to the
 * @blocknote/tiptap bundles (in dev, build, and test), so they are defined
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
 * Applied at optimizeDeps.rolldownOptions.plugins (vite) / top-level plugins
 * (vitest) so the patched code lands in the pre-bundle and test transform
 * pipeline. Fix here, not in node_modules (doesn't survive npm ci).
 */
import type { Plugin } from 'vite'

export function blocknoteMathWhitespaceCompat(): Plugin {
  return {
    name: 'blocknote-math-whitespace-compat',
    transform(code) {
      if (code.includes('new Set(["PRE", "CODE"])')) {
        return code.replace(
          'new Set(["PRE", "CODE"])',
          'new Set(["PRE", "CODE", "MATH", "ANNOTATION", "math", "annotation"])',
        )
      }
      if (code.includes('new Set([`PRE`,`CODE`])')) {
        return code.replace(
          'new Set([`PRE`,`CODE`])',
          'new Set([`PRE`,`CODE`,`MATH`,`ANNOTATION`,`math`,`annotation`])',
        )
      }
    },
  }
}

export function tiptapViewProxyCompat(): Plugin {
  const pattern = /if \(key in obj\) \{\s+return Reflect\.get\(obj, key\);\s*\}\s*throw new Error\(/;
  return {
    name: 'tiptap-view-proxy-compat',
    transform(code) {
      if (!pattern.test(code)) return
      return code.replace(
        pattern,
        `if (key in obj) {\n        return Reflect.get(obj, key);\n      }\n      if (key === "domAtPos") {\n        return () => ({ node: { scrollIntoView() {} }, text: undefined });\n      }\n      throw new Error(`,
      )
    },
  }
}
