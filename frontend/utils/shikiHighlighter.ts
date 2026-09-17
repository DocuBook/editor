/** The Shiki highlighter `SyntaxHighlightingExtension` tokenizes with.
 *
 *  Kept in its own module — and reached through a dynamic import from
 *  codeHighlighting.ts — because Shiki (core + the TextMate engines + the
 *  language/theme maps) is by far the largest thing this feature pulls in, and
 *  none of it is needed to open a document. See codeHighlighting.ts for why the
 *  extension wants a highlighter FACTORY rather than an instance.
 *
 *  - **Engine: pure JS.** The WASM engine needs `wasm-unsafe-eval`, which the
 *    Tauri CSP (`script-src 'self'`) does not grant, so it would be blocked in
 *    a release build. `forgiving` makes it skip grammar patterns the JS engine
 *    can't express rather than throwing mid-tokenize.
 *  - **Bundle: `shiki/core` + the lazy maps.** `shiki/langs` and `shiki/themes`
 *    resolve each grammar/theme through a dynamic import, so a language is only
 *    fetched the first time a block uses it; importing `shiki/core` keeps the
 *    Oniguruma engine out of the bundle entirely.
 *  - **Themes: one light + one dark.** Given a light/dark pair, the extension
 *    emits `--shiki-light` / `--shiki-dark` custom properties per token instead
 *    of a colour, leaving the choice to CSS — see the `[data-theme]` rule in
 *    index.css. The theme NAMES must contain "light" and "dark": that is how
 *    the pair is detected.
 */
import { createBundledHighlighter } from 'shiki/core'
import { bundledLanguages } from 'shiki/langs'
import { bundledThemes } from 'shiki/themes'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

const LIGHT_THEME = 'github-light'
const DARK_THEME = 'github-dark'

const createHighlighter = createBundledHighlighter({
  langs: bundledLanguages,
  themes: bundledThemes,
  engine: () => createJavaScriptRegexEngine({ forgiving: true }),
})

export const createEditorHighlighter = async () => {
  // No language is preloaded: the extension loads each grammar on first use,
  // which is also what keeps the initial payload free of grammars.
  const highlighter = await createHighlighter({ themes: [LIGHT_THEME, DARK_THEME], langs: [] })

  return {
    ...highlighter,
    /** Shiki throws SYNCHRONOUSLY when asked for a language outside the bundle.
     *  BlockNote's plugin only attaches `.catch()` to what it gets back, and
     *  `prosemirror-highlight` guards its parse loop as a whole — so a sync
     *  throw from one typo'd fence (` ```foo `) would skip highlighting for
     *  every other code block in that transaction, and the language would never
     *  be recorded as unsupported (retried, and logged, on every transaction).
     *  Rejecting instead hands it back to the plugin's own bookkeeping. */
    loadLanguage: (...languages: any[]) => {
      try {
        return highlighter.loadLanguage(...(languages as [any]))
      } catch (error) {
        return Promise.reject(error)
      }
    },
  }
}
