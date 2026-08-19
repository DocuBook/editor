
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Safari 15 (WKWebView, Tauri on macOS 12) doesn't support regex lookbehind.
 * marked@16 has a runtime feature-detection (`new RegExp("(?<=1)(?<!1)")` in
 * try/catch → falls back to a lookbehind-free pattern), but rolldown's oxc
 * const-eval evaluates that regex on the build machine (Node 22, which DOES
 * support lookbehind) and folds the detection to `true` — baking the broken
 * regex into the bundle.
 *
 * Same spirit as frontend/utils/iteratorPolyfill.ts: fix at our layer, don't
 * patch node_modules. This plugin rewrites the detection into an array-join
 * form oxc can't statically evaluate, so the check runs at runtime: Safari 15
 * throws → marked uses its built-in fallback. Verified: `new RegExp(["(?<=",
 * "1)(?<!1)"].join(""))` is NOT folded by rolldown (see test in git history).
 */
function markedLookbehindCompat(): Plugin {
  return {
    name: 'marked-lookbehind-compat',
    transform(code, id) {
      if (!id.includes('/marked/lib/marked.esm.js')) return
      if (!code.includes('new RegExp("(?<=1)(?<!1)")')) return
      return code.replace(
        'new RegExp("(?<=1)(?<!1)")',
        'new RegExp(["(?<=","1)(?<!1)"].join(""))',
      )
    },
  }
}

function blocknoteMathWhitespaceCompat(): import('vite').Plugin {
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

/**
 * Tiptap's `get view()` returns a Proxy that THROWS on property access (e.g.
 * `domAtPos`) when the editor view is not mounted. With keep-alive tab
 * instances, a detached view can be re-rendered (BlockPopover/useMemo,
 * AIExtension scroll) before/after remount — the throw propagates into React's
 * render phase and hits the error boundary. Patch the proxy to return a safe
 * placeholder for `domAtPos` instead: callers that need a real element simply
 * get an undefined node and skip their work.
 *
 * Applied to every tiptap copy (@blocknote/core, react, xl-ai) — the dist is
 * readable ESM with identical shape, so one regex covers all.
 */
function tiptapViewProxyCompat(): import('vite').Plugin {
  const pattern = /if \(key in obj\) \{\s+return Reflect\.get\(obj, key\);\s*\}\s*throw new Error\(/;
  return {
    name: 'tiptap-view-proxy-compat',
    transform(code) {
      if (!pattern.test(code)) return
      return code.replace(
        pattern,
        `if (key in obj) {\n        return Reflect.get(obj, key);\n      }\n      if (key === \"domAtPos\") {\n        return () => ({ node: { scrollIntoView() {} }, text: undefined });\n      }\n      throw new Error(`,
      )
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), markedLookbehindCompat(), blocknoteMathWhitespaceCompat(), tiptapViewProxyCompat()],
  clearScreen: false,
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://localhost:4282' } },
  envPrefix: ['VITE_', 'TAURI_'],
  build: { target: ['es2021', 'chrome105', 'safari15'], minify: !process.env.TAURI_DEBUG ? 'esbuild' : false, sourcemap: !!process.env.TAURI_DEBUG },
  // Dev dep pre-bundle needs its own target: `build.target` only applies to
  // the build, not to the dev optimizer. Without this, mermaid's `static {`
  // blocks survive into the pre-bundle and WKWebView (Safari 15) chokes.
  optimizeDeps: {
    // marked must flow through the dev transform pipeline (its lookbehind
    // detection needs the runtime rewrite), so it is excluded from the
    // pre-bundle. The @blocknote/tiptap compat transforms below run DURING the
    // rolldown optimize pass instead — deps stay pre-bundled (fast dev cold
    // start) and the patches land in the bundled output (verified: the fresh
    // prebundle contains the domAtPos guard + MATH whitespace preserve).
    exclude: ['marked'],
    rolldownOptions: {
      transform: { target: ['es2021', 'chrome105', 'safari15'] },
      // Merged with Vite's own dep plugin: our transform hooks run on the dep
      // sources before bundling, so the patched code is what gets cached.
      plugins: [blocknoteMathWhitespaceCompat() as any, tiptapViewProxyCompat() as any] as any,
    },
  },
})
