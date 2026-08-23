import { defineConfig } from "vitest/config";
import {
  blocknoteMathWhitespaceCompat,
  tiptapViewProxyCompat,
} from "./frontend/utils/viteCompatPlugins.js";

/** Same @blocknote/tiptap compat transforms as build/dev — single source in
 *  frontend/utils/viteCompatPlugins. Vitest inlines @blocknote and must apply
 *  the patches too (keep-alive detached-view + multiline math whitespace). */
export default defineConfig({
  plugins: [blocknoteMathWhitespaceCompat(), tiptapViewProxyCompat()],
  test: {
    include: ["test/unit/**/*.test.ts", "test/unit/**/*.test.tsx"],
    css: true,
    server: {
      deps: {
        inline: [/katex/, /@blocknote/],
      },
    },
  },
});
