import { useCallback, useEffect, useState } from 'react'
import { Checkbox, NumberInput, Select } from '@mantine/core'
import { toast } from 'sonner'
import { invoke, isTauri } from '../../lib/ipc'
import { DEFAULT_WEB_TOOLS, describeWebTools, parseWebToolsState, type WebSearchProvider, type WebToolsState } from '../../utils/webTools'

const INPUT_CLASS = 'w-full bg-background border border-border rounded px-3 py-2 text-xs font-mono disabled:opacity-60'
const SEARCH_PROVIDERS: { value: WebSearchProvider; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'tavily', label: 'Tavily (API key)' },
  { value: 'searxng', label: 'SearXNG (self-hosted)' },
]
const BUTTON_CLASS = 'px-3 py-2 rounded bg-accent text-on-accent border-0 text-xs cursor-pointer hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed'

/** Settings for rust-ai's built-in `web_search` / `web_fetch` tools. Both are
 *  off until enabled here; the backend validates and applies every change. */
export default function WebToolsSettings() {
  const [state, setState] = useState<WebToolsState | null>(null)
  const [draft, setDraft] = useState(DEFAULT_WEB_TOOLS)
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  /** Reload from the backend. `keepDraft` leaves unsaved edits alone: saving a
   *  Tavily key must not snap a not-yet-saved provider choice back to "off". */
  const refresh = useCallback(async (keepDraft = false) => {
    try {
      const next = parseWebToolsState(await invoke<string>('web_tools_settings'))
      setError(null)
      setState(next)
      if (!keepDraft) setDraft(next.settings)
    } catch (err) {
      setError(String(err))
    }
  }, [])
  /* oxlint-disable react/set-state-in-effect -- initial async load from the backend */
  useEffect(() => { void refresh() }, [refresh])
  /* oxlint-enable react/set-state-in-effect */

  /** Run one backend change, then reload so the pane shows what was applied. */
  const run = async (command: string, args: Record<string, unknown>, success: string, keepDraft = false) => {
    setSaving(true)
    try {
      await invoke(command, args)
      await refresh(keepDraft)
      toast.success(success)
      return true
    } catch (err) {
      toast.error(String(err))
      return false
    } finally {
      setSaving(false)
    }
  }

  if (error) {
    return <div role="alert" className="flex items-center gap-2 text-xs text-danger"><span>Could not load web tool settings: {error}</span><button type="button" onClick={() => { void refresh() }} className="text-xs">Retry</button></div>
  }
  if (!state) return <p role="status" className="text-xs text-muted">Loading web tool settings…</p>

  const disabled = saving
  const limit = state.maxResultsLimit
  const resultsValid = Number.isInteger(draft.maxResults) && draft.maxResults >= 1 && draft.maxResults <= limit
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.settings)

  return <div className="space-y-3" data-testid="web-tools-settings">
    <p className="text-xs text-muted leading-relaxed">Let the AI look things up before it edits your document. Results are treated as untrusted reference data, and pages can only be read from URLs in your prompt, the document (including links the AI added to it in an earlier turn), or earlier search results.</p>
    <p role="status" className="text-xs font-medium">{describeWebTools(state)}</p>
    {state.envManaged && <p className="text-xs text-warning">The search provider is controlled by DOCUBOOK_SEARXNG_URL / DOCUBOOK_TAVILY_API_KEY.</p>}

    <label className="block text-xs font-medium" htmlFor="web-search-provider">Web search</label>
    <Select
      id="web-search-provider"
      classNames={{ input: 'web-search-picker-input', dropdown: 'web-search-picker-dropdown', option: 'web-search-picker-option' }}
      data={SEARCH_PROVIDERS}
      value={draft.searchProvider}
      onChange={value => { if (value) setDraft({ ...draft, searchProvider: value as WebSearchProvider }) }}
      allowDeselect={false}
      disabled={disabled || state.envManaged}
    />

    {draft.searchProvider === 'tavily' && <div className="rounded border border-border-subtle p-3 space-y-2">
      <p className="text-[10px] text-muted">Tavily's terms allow it to use queries to improve its service, and queries can contain text from your notes. The free plan includes 1,000 searches a month.</p>
      {state.hasTavilyKey
        ? <div className="flex items-center justify-between text-xs"><span>API key saved</span>{!state.envManaged && <button type="button" disabled={disabled} onClick={() => void run('delete_web_search_key', {}, 'Tavily key removed', true)} className="text-xs text-danger bg-transparent border-0 cursor-pointer disabled:opacity-40">Remove key</button>}</div>
        : <>
          <label className="block text-xs font-medium" htmlFor="web-search-key">Tavily API key</label>
          <input id="web-search-key" disabled={disabled} type="password" autoComplete="new-password" value={key} onChange={e => setKey(e.target.value)} placeholder="tvly-…" className={INPUT_CLASS} />
          <button type="button" disabled={disabled || !key.trim()} onClick={() => void run('set_web_search_key', { key }, 'Tavily key saved', true).then(ok => { if (ok) setKey('') })} className={BUTTON_CLASS}>{saving ? 'Saving…' : 'Save key'}</button>
        </>}
    </div>}

    {draft.searchProvider === 'searxng' && <div className="space-y-2">
      <label className="block text-xs font-medium" htmlFor="web-searxng-url">SearXNG URL</label>
      <input id="web-searxng-url" disabled={disabled || state.envManaged} value={draft.searxngUrl} onChange={e => setDraft({ ...draft, searxngUrl: e.target.value })} placeholder="http://searxng:8080" className={INPUT_CLASS} />
      <p className="text-[10px] text-muted">Local or private addresses are fine; a public instance must use HTTPS. Enable <code>json</code> under <code>search.formats</code> in its settings.yml.</p>
    </div>}

    {draft.searchProvider !== 'off' && <>
      <label className="block text-xs font-medium" htmlFor="web-max-results">Results per search (1–{limit})</label>
      <NumberInput
        id="web-max-results"
        classNames={{ input: 'web-search-picker-input' }}
        disabled={disabled}
        min={1}
        max={limit}
        step={1}
        allowDecimal={false}
        allowNegative={false}
        value={draft.maxResults}
        /* An emptied field arrives as '' — NaN keeps Save disabled until a number is back. */
        onChange={value => setDraft({ ...draft, maxResults: typeof value === 'number' ? value : NaN })}
      />
    </>}

    <Checkbox
      classNames={{ input: 'web-fetch-checkbox-input', label: 'web-fetch-checkbox-label' }}
      size="xs"
      disabled={disabled}
      checked={draft.fetchEnabled}
      onChange={e => setDraft({ ...draft, fetchEnabled: e.currentTarget.checked })}
      label={<>Allow the AI to read web pages (<code>web_fetch</code>). Pages are fetched from this {isTauri ? 'computer' : 'server'}; internal and private addresses are always blocked.</>}
    />

    <button type="button" disabled={disabled || !dirty || !resultsValid} onClick={() => void run('set_web_tools_settings', { settings: draft }, 'Web tool settings saved')} className={BUTTON_CLASS}>{saving ? 'Saving…' : 'Save'}</button>
  </div>
}
