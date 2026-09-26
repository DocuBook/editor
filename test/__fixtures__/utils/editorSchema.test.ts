import { afterEach, describe, it, expect } from 'vitest'
import { codeBlockShortcuts, getSchema, isCodeBlockHeaderField, setPreviewRenderingPaused } from '../../../frontend/components/editor/setup'

/** getSchema() is pure schema construction (no editor instance, no DOM
 *  mount), so it is safe to exercise headless. These tests pin the React
 *  codeBlock replacement to the vanilla contract it mirrors: same node type,
 *  plain text content, and language prop defaulting to "text". */
describe('editor schema — codeBlock', () => {
  it('registers codeBlock with plain text content', () => {
    const schema: any = getSchema()
    const codeBlock = schema.blockSchema.codeBlock

    expect(codeBlock).toBeDefined()
    expect(codeBlock.type).toBe('codeBlock')
    // Vanilla contract: codeBlock holds plain text (newlines preserved,
    // single text node), NOT inline content — markdown round-trip depends
    // on it, and the AI-writing freeze relies on it too.
    expect(codeBlock.content).toBe('plain')
  })

  it('keeps the language prop with default "text"', () => {
    const schema: any = getSchema()
    const language = schema.blockSchema.codeBlock.propSchema.language

    expect(language.default).toBe('text')
  })
})

/** The language Shiki is asked to parse. It comes straight from the fence, and
 *  is withheld entirely while the AI writes — a streaming fence (` ```pyth `)
 *  must not make Shiki load a grammar for a language that does not exist yet. */
describe('editor schema — codeBlock highlighting', () => {
  const highlight = () => (getSchema() as any).blockSpecs.codeBlock.implementation.meta.highlight

  afterEach(() => setPreviewRenderingPaused(false))

  it('hands Shiki the fence language, title and other tokens stripped', () => {
    expect(highlight()({ props: { language: 'ts title="file.ts"' } })).toBe('ts')
  })

  it('hands Shiki nothing while the AI writes', () => {
    setPreviewRenderingPaused(true)

    expect(highlight()({ props: { language: 'pyth' } })).toBe('')
  })
})

/** The header's own fields keep their keys: the guard lives in ProseMirror (the
 *  picker is driven by React handlers, so stopping the event in the DOM would
 *  starve its ArrowUp/Down, Enter and Escape controls) — see setup.ts. */
describe('editor schema — code block header keys', () => {
  const headerField = { closest: (selector: string) => (selector === '.code-block-header' ? {} : null) }
  const editorBody = { closest: () => null }

  it('tells a header field from the rest of the document', () => {
    expect(isCodeBlockHeaderField(headerField)).toBe(true)
    expect(isCodeBlockHeaderField(editorBody)).toBe(false)
    expect(isCodeBlockHeaderField(null)).toBe(false)
  })

  it('claims those keys in the code block extension, without stopping the event', () => {
    const extension: any = (codeBlockShortcuts as any)({ editor: {} })
    const keydown = extension.prosemirrorPlugins
      .map((plugin: any) => plugin.props?.handleDOMEvents?.keydown)
      .find(Boolean)

    expect(keydown).toBeTypeOf('function')
    // true => ProseMirror skips its own handling (no default prevented, so the
    // field still receives the character); false => the document keeps its keys.
    expect(keydown(null, { target: headerField })).toBe(true)
    expect(keydown(null, { target: editorBody })).toBe(false)
  })
})