import { useState, useEffect, useRef, useCallback } from 'react'
import { invoke, isTauri } from '../lib/ipc'
import { toast } from 'sonner'
import { useAiSettings, CUSTOM_PROVIDER_ID } from '../stores/aiSettings'
import { useSettings, pageOf, groupOf, PAGE_FIRST_SECTION, type SettingsPageId } from '../stores/settings'
import { SETTINGS_GROUPS } from '../data/settingsTree'
import GitSettings from './GitSettings'
import SystemSettings from './SystemSettings'
import AppearanceSettings from './AppearanceSettings'
import SettingsSection from './settings/SettingsSection'
import ProviderForm from './settings/ProviderForm'

function McpSettings({ servers, envManaged, ready, loading, error, retry, defaultTimeoutSeconds, maxTimeoutSeconds }: { servers: Array<{name:string;url:string;timeoutSeconds?:number|null;hasToken:boolean;token?:string}>; envManaged: boolean; ready: boolean; loading: boolean; error: string | null; retry: () => Promise<void>; defaultTimeoutSeconds: number; maxTimeoutSeconds: number }) {
  const [draft, setDraft] = useState<{name:string;url:string;timeoutSeconds:string;token:string}>({name:'',url:'',timeoutSeconds:'',token:''})
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<{url:string;timeoutSeconds:string;token:string;removeToken:boolean}>({url:'',timeoutSeconds:'',token:'',removeToken:false})
  const disabled = !ready || envManaged || saving
  const save = async (next: any[]) => {
    if (!ready || envManaged || saving) return
    if (next.some(server => server.timeoutSeconds != null && (!Number.isInteger(server.timeoutSeconds) || server.timeoutSeconds < 1 || server.timeoutSeconds > maxTimeoutSeconds))) {
      toast.error(`Timeout must be 1–${maxTimeoutSeconds} seconds`)
      return
    }
    setSaving(true)
    try {
      const command = isTauri ? 'set_mcp_settings' : 'config_set'
      const args = isTauri ? { servers: next } : { key: 'mcp', value: next }
      await invoke(command, args)
      await retry()
      setDraft({name:'',url:'',timeoutSeconds:'',token:''})
      setEditing(null)
      toast.success('MCP server settings saved')
    } catch (error) { toast.error(String(error)) }
    setSaving(false)
  }
  return <div className="space-y-3">
    <p className="text-xs text-muted leading-relaxed">Name identifies this remote in DocuBook. Tools are discovered automatically; only allow-listed read-only tools are available. Add only trusted MCP endpoints.</p>
    {envManaged && <p className="text-xs text-warning">MCP servers are controlled by DOCUBOOK_MCP_SERVERS.</p>}
    {loading ? <p role="status" className="text-xs text-muted">Loading MCP server settings…</p> : error && <div role="alert" className="flex items-center gap-2 text-xs text-danger"><span>Could not load MCP server settings: {error}</span><button onClick={() => { void retry().catch(() => {}) }} className="text-xs">Retry</button></div>}
    {servers.map(server => <div key={server.name} className="rounded border border-border-subtle p-3 space-y-2">
      {editing === server.name ? <>
        <strong className="block text-xs">{server.name}</strong>
        <label className="block text-xs font-medium">HTTPS endpoint</label><input disabled={disabled} value={editDraft.url} onChange={e=>setEditDraft({...editDraft,url:e.target.value})} className="w-full bg-background border border-border rounded px-3 py-2 text-xs font-mono" />
        <label className="block text-xs font-medium">Request timeout override (seconds; default {defaultTimeoutSeconds}, max {maxTimeoutSeconds})</label><input disabled={disabled} type="number" min="1" max={maxTimeoutSeconds} step="1" value={editDraft.timeoutSeconds} onChange={e=>setEditDraft({...editDraft,timeoutSeconds:e.target.value})} placeholder={String(defaultTimeoutSeconds)} className="w-full bg-background border border-border rounded px-3 py-2 text-xs" />
        <label className="block text-xs font-medium">Replace bearer token (optional)</label><input disabled={disabled} type="password" autoComplete="new-password" value={editDraft.token} onChange={e=>setEditDraft({...editDraft,token:e.target.value})} className="w-full bg-background border border-border rounded px-3 py-2 text-xs font-mono" />
        <p className="text-[10px] text-muted">Sent as Authorization: Bearer for protected remote servers. Leave blank to keep the saved token, or use Remove saved token below.</p>
        {server.hasToken && <label className="flex items-center gap-2 text-xs"><input disabled={disabled} type="checkbox" checked={editDraft.removeToken} onChange={e=>setEditDraft({...editDraft,removeToken:e.target.checked,token:''})} />Remove saved token</label>}
        <div className="flex gap-2"><button disabled={disabled} onClick={() => void save(servers.map(item => item.name === server.name ? {...item,url:editDraft.url,timeoutSeconds:editDraft.timeoutSeconds.trim() ? Number(editDraft.timeoutSeconds) : null,...(editDraft.removeToken ? {token:'',removeToken:true} : editDraft.token ? {token:editDraft.token} : {})} : item))} className="text-xs">Save</button><button disabled={disabled} onClick={() => setEditing(null)} className="text-xs">Cancel</button></div>
      </> : <>
        <div className="flex items-center justify-between"><strong className="text-xs">{server.name}</strong><div className="flex gap-2"><button disabled={disabled} onClick={() => {setEditDraft({url:server.url,timeoutSeconds:server.timeoutSeconds == null ? '' : String(server.timeoutSeconds),token:'',removeToken:false});setEditing(server.name)}} className="text-xs bg-transparent border-0 cursor-pointer disabled:opacity-40">Edit</button><button disabled={disabled} onClick={() => void save(servers.filter(item => item.name !== server.name))} className="text-xs text-danger bg-transparent border-0 cursor-pointer disabled:opacity-40">Remove</button></div></div>
        <div className="text-[10px] text-muted break-all">{server.url}</div>
        <div className="text-[10px] text-muted">Timeout: {server.timeoutSeconds ?? defaultTimeoutSeconds}s{server.timeoutSeconds == null ? ' (default)' : ' (override)'} · {server.hasToken ? 'bearer token saved' : 'no bearer token'}</div>
      </>}
    </div>)}
    <label className="block text-xs font-medium">Server Name</label><input disabled={disabled} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})} className="w-full bg-background border border-border rounded px-3 py-2 text-xs" placeholder="docs" />
    <label className="block text-xs font-medium">HTTPS endpoint</label><input disabled={disabled} value={draft.url} onChange={e=>setDraft({...draft,url:e.target.value})} className="w-full bg-background border border-border rounded px-3 py-2 text-xs font-mono" placeholder="https://mcp.example.com/mcp" />
    <label className="block text-xs font-medium">Request timeout override (seconds; default {defaultTimeoutSeconds}, max {maxTimeoutSeconds})</label><input disabled={disabled} type="number" min="1" max={maxTimeoutSeconds} step="1" value={draft.timeoutSeconds} onChange={e=>setDraft({...draft,timeoutSeconds:e.target.value})} placeholder={String(defaultTimeoutSeconds)} className="w-full bg-background border border-border rounded px-3 py-2 text-xs" />
    <label className="block text-xs font-medium">Bearer token (optional)</label><input disabled={disabled} type="password" autoComplete="new-password" value={draft.token} onChange={e=>setDraft({...draft,token:e.target.value})} className="w-full bg-background border border-border rounded px-3 py-2 text-xs font-mono" />
    <p className="text-[10px] text-muted">Sent as Authorization: Bearer for protected remote servers. Leave blank if the server does not require bearer authentication.</p>
    <button disabled={disabled || !draft.name || !draft.url} onClick={() => void save([...servers, {name:draft.name,url:draft.url,timeoutSeconds:draft.timeoutSeconds.trim() ? Number(draft.timeoutSeconds) : null,token:draft.token}])} className="px-3 py-2 rounded bg-accent text-on-accent border-0 text-xs cursor-pointer disabled:opacity-40">{saving ? 'Saving…' : 'Add remote'}</button>
  </div>
}

/** The settings surface — the ONE implementation of the settings UI, rendered in
 *  the editor container and navigated by the sidebar tree. Every entry point
 *  (profile menu, ⌘,) flips the store's `open` flag; this component reads the
 *  store's selected section and renders that section's MENU page. */
export default function SettingsPane() {
  /** Section the sidebar last anchored to. Its MENU owns the page rendered here;
   *  the section itself is the `#id` scrolled into view inside that page. */
  const storeSection = useSettings(s => s.section)
  /** Pane: scroll the selected section into view inside the open page. Re-runs on
   *  every section change so a repeated click on the same row still re-centers it
   *  (the id is stable, but a user who scrolled away expects the jump back). */
  const paneScrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Ids are simple and unique app-wide, so a plain lookup beats a selector
    // (and avoids depending on CSS.escape, which jsdom does not always provide).
    const target = document.getElementById(storeSection)
    // jsdom has no layout; guard so tests never depend on scrollIntoView.
    target?.scrollIntoView?.({ block: 'start' })
  }, [storeSection])
  /** Selecting the Provider section seeds the CUSTOM provider when nothing is
   *  selected yet, so the section's first form has an endpoint to edit. It never
   *  overrides a provider the user already chose. */
  useEffect(() => {
    if (storeSection === 'ai-provider' && !useAiSettings.getState().provider) useAiSettings.getState().setProvider(CUSTOM_PROVIDER_ID)
  }, [storeSection])

  const [mcpServers, setMcpServers] = useState<Array<{name:string;url:string;timeoutSeconds?:number|null;hasToken:boolean;token?:string}>>([])
  const [mcpEnvManaged, setMcpEnvManaged] = useState(false)
  const [mcpDefaultTimeout, setMcpDefaultTimeout] = useState(10)
  const [mcpMaxTimeout, setMcpMaxTimeout] = useState(120)
  const [mcpLoading, setMcpLoading] = useState(true)
  const [mcpError, setMcpError] = useState<string | null>(null)
  const refreshMcpSettings = useCallback(async () => {
    setMcpLoading(true)
    setMcpError(null)
    try {
      const raw = await invoke<string>('mcp_settings')
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      const list = Array.isArray(parsed) ? parsed : parsed?.servers ?? parsed?.mcp
      if (!Array.isArray(list)) throw new Error('Invalid MCP settings response')
      setMcpServers(list.map((server: any) => ({ ...server, name: server.name ?? server.id })))
      setMcpEnvManaged(!!parsed?.envManaged)
      if (Number.isInteger(parsed?.defaultTimeoutSeconds)) setMcpDefaultTimeout(parsed.defaultTimeoutSeconds)
      if (Number.isInteger(parsed?.maxTimeoutSeconds)) setMcpMaxTimeout(parsed.maxTimeoutSeconds)
    } catch (error) {
      setMcpError(String(error))
      throw error
    } finally {
      setMcpLoading(false)
    }
  }, [])
  /* oxlint-disable react/set-state-in-effect -- initial async load from the backend */
  useEffect(() => { void refreshMcpSettings().catch(() => {}) }, [refreshMcpSettings])
  /* oxlint-enable react/set-state-in-effect */

  /** The page rendered here, and the sidebar MENU that owns it. */
  const page = pageOf(storeSection)
  const activeGroup = groupOf(storeSection)
  /** The FIRST section of each page is the `h2` PAGE TITLE, not a section body:
   *  its anchor id lives on the heading so the sidebar row scrolls to the title
   *  itself. The remaining sections keep their own `<section id>`. Looking the id
   *  up in the tree (rather than hardcoding a map) keeps the ids — or a page that
   *  gains/loses a first section — in one place: the nav data. */
  const firstSectionId = PAGE_FIRST_SECTION[page]
  /** True when the first section IS the title (always, in the shipped tree). The
   *  section below it then keeps its divider (the title replaced the section that
   *  would otherwise sit on top of it); GitSettings reads this the same way. */
  const titleIsFirstSection = SETTINGS_GROUPS.find(group => group.id === activeGroup)?.items[0]?.id === firstSectionId

  /** The page title IS its menu name, so the pane and the sidebar row that opened
   *  it always read the same. One heading per page. */
  const pageTitle: Record<SettingsPageId, string> = {
    general: 'General',
    git: 'Git',
    ai: 'AI',
  }

  /** Pages keyed by PAGE (not by section): each page owns one view, and its
   *  sections are the anchored anchors inside it. Clicking a section opens its
   *  page and scrolls to that section's id. Sections own their own spacing and
   *  divider (SettingsSection), so the page adds none of its own. */
  const pages: Record<SettingsPageId, React.ReactNode> = {
    /** General is the first page: themes, plus Account on Docker only (the
     *  desktop app has no account or runtime config, so the section is absent
     *  there — matching the sidebar, which hides that row on desktop). */
    general: (
      <>
        {/* No id: the page title above already IS this section's anchor, and a
            duplicate id would make the first sidebar row a dead link twice over. */}
        <SettingsSection title="Themes" first><AppearanceSettings /></SettingsSection>
        {!isTauri && <SettingsSection id="general-account" title="Account"><SystemSettings /></SettingsSection>}
      </>
    ),
    /** Git identity + remotes are the two sections on the ONE Git page; each
     *  carries its own id (rendered inside GitSettings) so both rows have a real
     *  target. */
    git: <GitSettings titleIsFirstSection={titleIsFirstSection} />,
    /** The AI page has TWO sections: Provider (all three provider forms, ONE per
     *  provider, each pinned to its provider) and MCP Server. The sidebar lists
     *  these two rows; the forms inside Provider are content, not anchors. */
    ai: (
      <>
        {/* No id: the page title above IS the Provider anchor (see General). */}
        <SettingsSection title="Provider" first>
          {/* No `space-y-*` here: each form carries its own top margin + divider via
              FORM_DIVIDER_CLASS, and a spacing utility would add a second gap and
              defeat the `first` opt-out that keeps the top card divider-free. */}
          <ProviderForm provider={CUSTOM_PROVIDER_ID} first />
          <ProviderForm provider="opencode-go" />
          <ProviderForm provider="deepseek" />
        </SettingsSection>
        <SettingsSection id="ai-mcp-server" title="MCP Server"><McpSettings servers={mcpServers} envManaged={mcpEnvManaged} loading={mcpLoading} error={mcpError} retry={refreshMcpSettings} ready={!mcpLoading && !mcpError} defaultTimeoutSeconds={mcpDefaultTimeout} maxTimeoutSeconds={mcpMaxTimeout} /></SettingsSection>
      </>
    ),
  }

  /** Editor-container surface: the ONE page the selected section's page owns.
   *  No overlay — the workspace stays interactive, and no other menu is stacked
   *  behind it. */
  return (
    <div data-testid="settings-container" className="flex-1 flex flex-col min-w-0 min-h-0">
      <div ref={paneScrollRef} className="settings-pane-scroll flex-1 min-h-0 overflow-y-auto px-6 py-10">
        <div className="mx-auto w-full max-w-2xl">
          {/* The first section's anchor id rides the page title, so its sidebar
              row scrolls to the heading. One id, on the heading, per page. */}
          <h2 data-testid="settings-page-heading" id={titleIsFirstSection ? firstSectionId : undefined} className="text-base font-semibold text-foreground mb-6 scroll-mt-8">{pageTitle[page]}</h2>
          {pages[page]}
        </div>
      </div>
    </div>
  )
}
