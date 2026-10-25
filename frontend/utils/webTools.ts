/** Types and pure helpers for rust-ai's built-in web tools (`web_search`,
 *  `web_fetch`). The backend owns validation and the SSRF guard; this module
 *  only shapes settings and collects the URLs a prompt turn may fetch. */

export type WebSearchProvider = 'off' | 'tavily' | 'searxng'

/** Non-secret settings, as `web_tools_settings` returns and
 *  `set_web_tools_settings` accepts them. */
export interface WebToolsSettings {
  searchProvider: WebSearchProvider
  searxngUrl: string
  fetchEnabled: boolean
  maxResults: number
}

/** `web_tools_settings` payload. */
export interface WebToolsState {
  settings: WebToolsSettings
  hasTavilyKey: boolean
  /** Docker env (DOCUBOOK_SEARXNG_URL / DOCUBOOK_TAVILY_API_KEY) pins the provider. */
  envManaged: boolean
  maxResultsLimit: number
}

export const DEFAULT_WEB_TOOLS: WebToolsSettings = { searchProvider: 'off', searxngUrl: '', fetchEnabled: false, maxResults: 5 }

/** URLs seeded per prompt turn; the backend applies the same cap. */
const MAX_URL_SOURCES = 200
const URL_PATTERN = /https?:\/\/[^\s<>"'`\\^{}|[\]]+/g
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', '*', '_'])

/** Strip sentence punctuation the URL pattern swallowed. A trailing `)` only
 *  goes while it is unbalanced, so `Rust_(programming_language)` survives; the
 *  backend ledger (`core/rust-ai/web/ledger.rs`) applies the same rule. */
function trimTrailingPunctuation(url: string): string {
  while (url) {
    const last = url[url.length - 1]
    const unbalanced = last === ')' && count(url, ')') > count(url, '(')
    if (!TRAILING_PUNCTUATION.has(last) && !unbalanced) break
    url = url.slice(0, -1)
  }
  return url
}

function count(text: string, char: string): number {
  let n = 0
  for (const c of text) if (c === char) n++
  return n
}

/** Parse a `web_tools_settings` reply, filling defaults for missing fields. */
export function parseWebToolsState(raw: unknown): WebToolsState {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw
  const settings = { ...DEFAULT_WEB_TOOLS, ...(value?.settings ?? {}) } as WebToolsSettings
  return {
    settings,
    hasTavilyKey: value?.hasTavilyKey === true,
    envManaged: value?.envManaged === true,
    maxResultsLimit: Number.isInteger(value?.maxResultsLimit) ? value.maxResultsLimit : 10,
  }
}

/** Human summary of what the AI can reach, for the settings header. */
export function describeWebTools(state: WebToolsState): string {
  const { settings, hasTavilyKey } = state
  const search = settings.searchProvider === 'tavily'
    ? (hasTavilyKey ? 'Tavily search' : 'Tavily search (key missing)')
    : settings.searchProvider === 'searxng'
      ? (settings.searxngUrl ? 'SearXNG search' : 'SearXNG search (URL missing)')
      : null
  const parts = [search, settings.fetchEnabled ? 'page fetch' : null].filter(Boolean)
  return parts.length ? `Enabled: ${parts.join(' + ')}` : 'Off — the AI cannot reach the web'
}

/** Absolute http(s) URLs in `text`, de-duplicated, trailing punctuation removed. */
export function extractUrls(text: string): string[] {
  const seen = new Set<string>()
  for (const match of text.match(URL_PATTERN) ?? []) {
    seen.add(trimTrailingPunctuation(match))
    if (seen.size >= MAX_URL_SOURCES) break
  }
  return [...seen]
}

/** URLs from the user's own messages and their document state: the only URLs
 *  `web_fetch` may open before a search or fetch result adds more. */
export function collectUrlSources(messages: readonly any[]): string[] {
  const texts: string[] = []
  for (const message of messages) {
    if (message?.role !== 'user') continue
    for (const part of Array.isArray(message.parts) ? message.parts : []) {
      if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text)
    }
    if (typeof message.content === 'string') texts.push(message.content)
    const state = message?.metadata?.documentState
    if (state) texts.push(JSON.stringify(state))
  }
  return extractUrls(texts.join('\n')).slice(0, MAX_URL_SOURCES)
}
