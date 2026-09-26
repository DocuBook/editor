import { afterEach, describe, it, expect } from 'vitest'
import { getSchema, setPreviewRenderingPaused } from '../../../frontend/components/editor/setup'

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