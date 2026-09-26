import { describe, expect, it } from 'vitest'
import { loadCodeLanguages } from '../../../frontend/utils/codeLanguages'

/** The dropdown's options must be exactly what the Shiki highlighter can load:
 *  an option the bundle does not know would write a fence that never
 *  highlights. The header itself never calls this while rendering — see the
 *  code block source view test, which pins the fence token being shown as-is. */
describe('loadCodeLanguages', () => {
  it('offers plain text first, then Shiki languages by display name', async () => {
    const languages = await loadCodeLanguages()

    expect(languages[0]).toMatchObject({ id: 'text', name: 'Text' })
    const names = languages.slice(1).map((language) => language.name)
    expect(names.length).toBeGreaterThan(200)
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names)
  })

  it('carries the terms a search matches: id, name and Shiki aliases', async () => {
    const languages = await loadCodeLanguages()
    const byId = (id: string) => languages.find((language) => language.id === id)!

    expect(byId('javascript').searchTerms).toContain('js')
    expect(byId('javascript').searchTerms).toContain('javascript')
    expect(byId('typescript').searchTerms).toContain('ts')
    expect(byId('text').searchTerms).toContain('txt')
  })

  it('offers unique ids, so every option is pickable and writable', async () => {
    const languages = await loadCodeLanguages()
    const ids = languages.map((language) => language.id)

    expect(new Set(ids).size).toBe(ids.length)
    // The id whose alias a fence usually carries (` ```js `).
    expect(ids).toContain('javascript')
  })
})
