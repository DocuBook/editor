import { defineConfig } from 'vitest/config'
import { blocknoteMathWhitespaceCompat, tiptapViewProxyCompat } from './frontend/utils/viteCompatPlugins.js'

/** Same @blocknote/tiptap compat transforms as build/dev — single source in
 *  frontend/utils/viteCompatPlugins. Vitest inlines @blocknote and must apply
 *  the patches too (keep-alive detached-view + multiline math whitespace). */
export default defineConfig({
  plugins: [blocknoteMathWhitespaceCompat(), tiptapViewProxyCompat()],
  test: {
    include: ['frontend/**/*.test.ts', 'frontend/**/*.test.tsx'],
    css: true,
    deps: {
      inline: [/katex/, /@blocknote/],
    },
    server: {
      deps: {
        inline: [/katex/, /@blocknote/],
      },
    },
  },
})
