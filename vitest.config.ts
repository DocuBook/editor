import { defineConfig } from 'vitest/config'

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

/** Same tiptap view-proxy guard as vite.config.ts — vitest imports the same
 *  @blocknote bundles, so the keep-alive detached-view crash must be patched
 *  here too or tests hit it (jsdom mounts views per test file). */
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
