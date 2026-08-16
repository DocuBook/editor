
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

export default defineConfig({
  plugins: [react(), tailwindcss(), markedLookbehindCompat()],
  clearScreen: false,
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://localhost:4282' } },
  envPrefix: ['VITE_', 'TAURI_'],
  build: { target: ['es2021', 'chrome105', 'safari15'], minify: !process.env.TAURI_DEBUG ? 'esbuild' : false, sourcemap: !!process.env.TAURI_DEBUG },
  // Dev dep pre-bundle needs its own target: `build.target` only applies to
  // the build, not to the dev optimizer. Without this, mermaid's `static {`
  // blocks survive into the pre-bundle and WKWebView (Safari 15) chokes.
  optimizeDeps: {
    exclude: ['marked'], // served via transform pipeline → markedLookbehindCompat runs
    rolldownOptions: {
      transform: { target: ['es2021', 'chrome105', 'safari15'] },
    },
  },
})
