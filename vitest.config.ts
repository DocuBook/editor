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

export default defineConfig({
  plugins: [blocknoteMathWhitespaceCompat()],
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
