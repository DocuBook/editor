import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { blocknoteMathWhitespaceCompat, tiptapViewProxyCompat } from './frontend/utils/viteCompatPlugins.js'

export default defineConfig({
  plugins: [react(), tailwindcss(), blocknoteMathWhitespaceCompat(), tiptapViewProxyCompat()],
  clearScreen: false,
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://localhost:4282' } },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: ['es2021', 'chrome151', 'safari17.6'],
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    // Every chunk over this limit is already correctly split, so the warning no
    // longer points at anything actionable — it just fires on the four chunks
    // that ARE the app: the entry (713 kB / 224 kB gzip), the lazy
    // WysiwygEditorHost (906 kB — the whole BlockNote/Tiptap/Mantine editor), and
    // two lazy Shiki grammars (cpp 767 kB, emacs-lisp 771 kB, fetched only when a
    // code block uses them). Mermaid's parser is one indivisible generated module
    // (~669 kB / 151 kB gzip). Raise this only alongside a chunk that is NOT
    // already behind a dynamic import — otherwise the warning stops being useful.
    chunkSizeWarningLimit: 1000,
    rolldownOptions: {
      // sync.ts dynamically imports stores/editor to break the static cycle
      // (editor.ts imports sync.ts). editor.ts is in the entry chunk anyway via
      // App.tsx, so the dynamic import cannot split anything — the warning is
      // accurate but permanently unactionable. See the note at the import site.
      checks: { ineffectiveDynamicImport: false },
      output: {
        codeSplitting: {
          groups: [
            { name: 'react-icons', test: /node_modules[\\/]react-icons[\\/]/ },
            { name: 'katex', test: /node_modules[\\/]katex[\\/]/ },
            { name: 'ai-sdk', test: /node_modules[\\/](?:ai|@ai-sdk)[\\/]/ },
          ],
        },
      },
    },
  },
  // Dev dep pre-bundle needs its own target: `build.target` only applies to
  // the build, not to the dev optimizer. Without this, dependency syntax newer
  // than the engine floor survives into the pre-bundle.
  optimizeDeps: {
    // The @blocknote/tiptap compat transforms (shared module
    // frontend/utils/viteCompatPlugins) run DURING the rolldown optimize pass
    // — deps stay pre-bundled (fast dev cold start) and the patches land in
    // the bundled output (verified: the fresh prebundle contains the domAtPos
    // guard + MATH whitespace preserve).
    rolldownOptions: {
      transform: { target: ['es2021', 'chrome151', 'safari17.6'] },
      // Merged with Vite's own dep plugin: our transform hooks run on the dep
      // sources before bundling, so the patched code is what gets cached.
      plugins: [blocknoteMathWhitespaceCompat() as any, tiptapViewProxyCompat() as any] as any,
    },
  },
})
