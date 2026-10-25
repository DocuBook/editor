import { describe, expect, it } from 'vitest'
import { collectUrlSources, DEFAULT_WEB_TOOLS, describeWebTools, extractUrls, parseWebToolsState } from '../../../frontend/utils/webTools'

describe('web tools helpers', () => {
  it('extracts URLs without trailing punctuation or duplicates', () => {
    expect(extractUrls('See https://a.example/x, (https://b.example/y). Again https://a.example/x and http://c.example/z?q=1.'))
      .toEqual(['https://a.example/x', 'https://b.example/y', 'http://c.example/z?q=1'])
  })

  it('keeps balanced parentheses inside URLs', () => {
    expect(extractUrls('(see https://en.wikipedia.org/wiki/Rust_(programming_language)). Or https://a.example/f(x)?!'))
      .toEqual(['https://en.wikipedia.org/wiki/Rust_(programming_language)', 'https://a.example/f(x)'])
  })

  it('seeds only from the user\'s messages and document state', () => {
    const urls = collectUrlSources([
      { role: 'assistant', parts: [{ type: 'text', text: 'model said https://model.example/' }] },
      { role: 'user', parts: [{ type: 'text', text: 'read https://prompt.example/page' }], metadata: { documentState: { blocks: [{ block: '<p><a href="https://doc.example/ref">ref</a></p>' }] } } },
      { role: 'user', content: 'and https://plain.example/' },
    ])
    expect(urls).toEqual(['https://prompt.example/page', 'https://doc.example/ref', 'https://plain.example/'])
  })

  it('parses the settings payload with defaults for missing fields', () => {
    const state = parseWebToolsState(JSON.stringify({ settings: { fetchEnabled: true }, hasTavilyKey: true }))
    expect(state.settings).toEqual({ ...DEFAULT_WEB_TOOLS, fetchEnabled: true })
    expect(state).toMatchObject({ hasTavilyKey: true, envManaged: false, maxResultsLimit: 10 })
  })

  it('describes what the AI can reach', () => {
    const base = parseWebToolsState({ settings: {} })
    expect(describeWebTools(base)).toMatch(/^Off/)
    expect(describeWebTools({ ...base, settings: { ...base.settings, searchProvider: 'tavily' } })).toBe('Enabled: Tavily search (key missing)')
    expect(describeWebTools({ ...base, hasTavilyKey: true, settings: { ...base.settings, searchProvider: 'tavily', fetchEnabled: true } })).toBe('Enabled: Tavily search + page fetch')
    expect(describeWebTools({ ...base, settings: { ...base.settings, searchProvider: 'searxng', searxngUrl: 'http://searxng:8080' } })).toBe('Enabled: SearXNG search')
  })
})
