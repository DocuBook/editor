import { describe, expect, it } from 'vitest'
import { syntaxHighlighting } from '../../../frontend/utils/codeHighlighting'
import { createEditorHighlighter } from '../../../frontend/utils/shikiHighlighter'

/** Wiring check only: the Shiki highlighter is created lazily on the first
 *  highlight, so exercising the extension needs neither a highlighter instance
 *  nor a DOM — just the editor shape `collectHighlightNodeTypes` reads. */
const editorWithCodeBlock = () => ({
  schema: {
    blockSpecs: {
      codeBlock: {
        config: { type: 'codeBlock', content: 'plain' },
        implementation: { meta: { highlight: () => 'ts' } },
      },
    },
    inlineContentSpecs: {},
  },
})

describe('syntaxHighlighting', () => {
  it('installs the highlight plugin for the editor schema', () => {
    const instance: any = syntaxHighlighting({ editor: editorWithCodeBlock() } as any)

    expect(instance.prosemirrorPlugins).toHaveLength(1)
  })

  it('only collects nodes whose spec declares a highlight language', () => {
    const instance: any = syntaxHighlighting({
      editor: {
        schema: {
          blockSpecs: {
            paragraph: { config: { type: 'paragraph', content: 'inline' }, implementation: { meta: {} } },
          },
          inlineContentSpecs: {},
        },
      },
    } as any)

    // No eligible node type: the plugin is still installed, it just never asks
    // Shiki for anything.
    expect(instance.prosemirrorPlugins).toHaveLength(1)
  })
})

/** The three choices inside the factory that are not obvious from its call
 *  site: nothing is preloaded, the grammars resolve lazily by name (what the
 *  extension relies on), and the light/dark pair reaches the tokens as CSS
 *  custom properties rather than as a baked-in colour. */
describe('createEditorHighlighter', () => {
  it('loads grammars on demand and reports unknown languages', async () => {
    const highlighter = await createEditorHighlighter()

    expect(highlighter.getLoadedLanguages()).not.toContain('ts')
    await highlighter.loadLanguage('ts' as any)
    expect(highlighter.getLoadedLanguages()).toContain('ts')
  })

  /** A fence language no grammar covers must fail as a promise: the plugin
   *  catches per language, and a synchronous throw would take the rest of the
   *  transaction's code blocks down with it. */
  it('rejects instead of throwing for a language outside the bundle', async () => {
    const highlighter = await createEditorHighlighter()

    const attempt = highlighter.loadLanguage('not-a-language' as any)

    expect(attempt).toBeInstanceOf(Promise)
    await expect(attempt).rejects.toThrow('not included in this bundle')
  })

  it('emits both themes as CSS variables on every token', async () => {
    const highlighter = await createEditorHighlighter()
    await highlighter.loadLanguage('ts' as any)

    const { tokens } = highlighter.codeToTokens('const a = 1', {
      lang: 'ts',
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
    })
    const styles = tokens.flat().map((token) => token.htmlStyle).filter(Boolean)

    expect(styles.length).toBeGreaterThan(0)
    expect(styles.every((style) => '--shiki-light' in style! && '--shiki-dark' in style!)).toBe(true)
  })
})
