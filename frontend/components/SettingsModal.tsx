import { useState, useEffect, useRef } from 'react'
import { invoke, isTauri } from '../lib/ipc'
import { toast } from 'sonner'
import { X, Eye, EyeOff, Check, Loader, ChevronsUpDown, Search } from 'lucide-react'
import { useAiSettings, CUSTOM_PROVIDER_ID } from '../stores/aiSettings'
import { resolveProbeModel, autoProbe } from '../utils/aiProbe'
import GitSettings from './GitSettings'
import SystemSettings from './SystemSettings'
import AppearanceSettings from './AppearanceSettings'
import type { ProviderInfo } from '../data/providers'

/** Synthetic provider for user-configured OpenAI-compatible endpoints — NOT in the
 *  generated catalog (providers.ts is auto-generated from models.dev and would
 *  overwrite it). Base URL + key are bound server-side via set_custom_endpoint. */
const CUSTOM_PROVIDER: ProviderInfo = { id: CUSTOM_PROVIDER_ID, name: 'OpenAI Compatible (Custom)', api: '', models: [] }

/** Badge for providers currently on the text-only path (no tool-call
 *  streaming). Source of truth is the measured probe (aiSettings.probeTools):
 *  probe false → text-only; custom endpoints are text-only until probed true.
 *  Unprobed providers show no badge — permissive default sends tools. */
const TextOnlyBadge = () => (
  <span title="AI writes via markdown → suggestion (no tool-call streaming)"
    className="text-[9px] uppercase tracking-wide px-1 py-px rounded bg-surface-active text-muted border border-border-subtle shrink-0">
    text-only
  </span>
)

const isTextOnlyProvider = (id: string, model: string, probeTools: Record<string, Record<string, boolean>>) => {
  const probe = model ? probeTools[id]?.[model] : undefined
  return probe === false || (id === CUSTOM_PROVIDER_ID && probe !== true)
}

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<'ai' | 'appearance' | 'git' | 'system'>('ai')
  const { provider, model, savedProviders, models, probeTools,
    setProvider, setModel, clearApiKey, addSavedProvider, removeSavedProvider } = useAiSettings()

  /** API key is entered here but NEVER read back from the backend —
   *  the key stays in the keychain (SEC-5: keys are backend-only). */
  const [keyInput, setKeyInput] = useState('')

  /** Custom base URL for the OpenAI-compatible provider (persisted in the store). */
  const [baseUrlInput, setBaseUrlInput] = useState('')

  /** Custom provider config from the backend — source "env" means Docker
   *  overrides via DB_OPENAI_COMPAT_* → the UI renders read-only. */
  const [customCfg, setCustomCfg] = useState<{ source: string; baseUrl?: string; hasKey: boolean; model?: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    invoke<string>('custom_ai_config').then(s => {
      if (cancelled) return
      try {
        const cfg = JSON.parse(s)
        setCustomCfg(cfg)
        // Env model is forced — sync the store so transport + probe align.
        if (cfg.source === 'env' && cfg.model) useAiSettings.getState().setModel(cfg.model)
      } catch {}
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  const envCustom = customCfg?.source === 'env'
  const envBadge = <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30 ml-2">from env</span>

  /** Auto-probe when the selected model changes and has no stored probe yet.
   *  Custom endpoints are text-only until measured true — a model switch would
   *  otherwise silently drop tool calls until a manual Test. Env-controlled
   *  custom endpoints probe the ENV model (backend uses it regardless). */
  useEffect(() => {
    if (!provider || !model) return
    const p = providers.find(x => x.id === provider)
    const probeModel = resolveProbeModel(provider, model, envCustom ? customCfg?.model : undefined)
    if (!probeModel) return
    // Skip env-controlled custom: the probe must run against the env key/baseUrl
    // which the backend resolves — invoke with empty UI values lets it do that.
    void autoProbe(provider, probeModel, probeTools, useAiSettings.getState().setProbeTools, async () => {
      const result = await invoke<string>('test_connection', {
        provider,
        model: probeModel,
        baseUrl: provider === CUSTOM_PROVIDER_ID ? (envCustom ? '' : baseUrlInput.trim()) : p?.api || '',
        apiKey: envCustom ? '' : keyInput,
      })
      try { const parsed = JSON.parse(result); if (typeof parsed.tools === 'boolean') return { tools: parsed.tools } } catch {}
      return undefined
    })
  }, [model, provider])

  /** Provider catalog lazy-loaded (2.17 MB — not part of the initial bundle). */
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const providersRef = useRef<ProviderInfo[]>([])
  useEffect(() => {
    let cancelled = false
    import('../data/providers').then(m => {
      if (cancelled) return
      providersRef.current = [CUSTOM_PROVIDER, ...m.PROVIDERS]
      setProviders([CUSTOM_PROVIDER, ...m.PROVIDERS])
    })
    return () => { cancelled = true }
  }, [])

  const [providerSearch, setProviderSearch] = useState('')
  const [showProviderDropdown, setShowProviderDropdown] = useState(false)
  const [providerHighlightIdx, setProviderHighlightIdx] = useState(0)

  const [modelSearch, setModelSearch] = useState('')
  const [showModelDropdown, setShowModelDropdown] = useState(false)
  const [modelHighlightIdx, setModelHighlightIdx] = useState(0)
  const [providerDropdownPos, setProviderDropdownPos] = useState<React.CSSProperties | null>(null)
  const [modelDropdownPos, setModelDropdownPos] = useState<React.CSSProperties | null>(null)

  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  const providerRef = useRef<HTMLDivElement>(null)
  const modelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const modelSearchRef = useRef<HTMLInputElement>(null)
  const providerListRef = useRef<HTMLDivElement>(null)
  const modelListRef = useRef<HTMLDivElement>(null)

  const selectedProvider: ProviderInfo | null = provider
    ? provider === CUSTOM_PROVIDER_ID ? CUSTOM_PROVIDER : providers.find(p => p.id === provider) || null
    : null
  const isCustom = provider === CUSTOM_PROVIDER_ID
  const savedSet = new Set(savedProviders)

  /** Keep the custom base URL input in sync with the selected provider. */
  useEffect(() => {
    setBaseUrlInput(useAiSettings.getState().baseUrls[provider] || '')
  }, [provider])

  /** Resync which providers have saved keys — one batch call instead of one invoke per provider. */
  useEffect(() => {
    (async () => {
      try {
        const ids = JSON.parse(await invoke<string>('list_api_keys', { providers: providers.map(p => p.id) })) as string[]
        ids.forEach(id => addSavedProvider(id))
      } catch {}
    })()
  }, [])

  /** Scroll highlighted provider into view on keyboard navigation */
  useEffect(() => {
    if (!showProviderDropdown) return
    const el = providerListRef.current?.children[providerHighlightIdx] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [providerHighlightIdx, showProviderDropdown])

  /** Scroll highlighted model into view on keyboard navigation */
  useEffect(() => {
    if (!showModelDropdown) return
    const el = modelListRef.current?.children[modelHighlightIdx] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [modelHighlightIdx, showModelDropdown])

  useEffect(() => {
    const h = (e: MouseEvent) => { if (providerRef.current && !providerRef.current.contains(e.target as Node)) { setShowProviderDropdown(false); setProviderDropdownPos(null) } }
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [])

  useEffect(() => {
    const h = (e: MouseEvent) => { if (modelRef.current && !modelRef.current.contains(e.target as Node)) { setShowModelDropdown(false); setModelDropdownPos(null) } }
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [])

  const filteredProviders = providers.filter(p =>
    !providerSearch || p.name.toLowerCase().includes(providerSearch.toLowerCase()) || p.id.toLowerCase().includes(providerSearch.toLowerCase())
  )

  const selectProviderFn = (p: ProviderInfo) => {
    setProvider(p.id) // restores saved apiKey + model for this provider
    if (p.id !== CUSTOM_PROVIDER_ID && !models[p.id]) { import('../data/providers').then(m => { if (!useAiSettings.getState().models[p.id]) setModel(m.getDefaultModel(p.id) || '') }) } // only default if never chosen
    setShowProviderDropdown(false)
  }

  const handleSave = async () => {
    if (!provider || !keyInput || (isCustom && !baseUrlInput.trim())) return
    setSaving(true)
    try {
      if (isCustom) {
        await invoke('set_custom_endpoint', { provider, baseUrl: baseUrlInput.trim(), key: keyInput })
        useAiSettings.getState().setBaseUrl(baseUrlInput.trim())
      } else {
        await invoke('set_api_key', { provider, key: keyInput })
      }
      addSavedProvider(provider)
      setKeyInput('')
      toast.success('API key saved')
    } catch (e) { toast.error('Failed to save API key'); console.error(e) }
    setSaving(false)
    // Auto-probe right after saving so the badge + transport use MEASURED
    // tool-call support, not the conservative default (unmeasured → text-only).
    const p = providers.find(x => x.id === provider)
    // For env-controlled custom endpoints the probe must target the ENV model
    // (the backend sends it regardless of the UI value).
    const probeModel = resolveProbeModel(provider, model || p?.models[0]?.id || '', envCustom ? customCfg?.model : undefined)
    try {
      const result = await invoke<string>('test_connection', { provider, model: probeModel, baseUrl: isCustom ? baseUrlInput.trim() : p?.api || '', apiKey: keyInput })
      let tools: boolean | undefined
      try { const parsed = JSON.parse(result); if (typeof parsed.tools === 'boolean') tools = parsed.tools } catch {}
      if (tools !== undefined) {
        useAiSettings.getState().setProbeTools(provider, probeModel, tools)
        toast.success(tools === true ? 'Tool calls supported' : 'Text-only — tool calls rejected by this gateway')
      }
    } catch { /* probe failed — badge stays at the default; Test button remains available */ }
  }

  const handleTest = async () => {
    if (!provider || (!keyInput && !envCustom) || (isCustom && !baseUrlInput.trim() && !envCustom)) return
    setTesting(true)
    try {
      const p = providers.find(x => x.id === provider)
      const probeModel = resolveProbeModel(provider, model || p?.models[0]?.id || '', envCustom ? customCfg?.model : undefined)
      // Test ONLY checks connectivity — it does not measure or persist tool-call
      // support (that's handleSave auto-probe and the model-switch effect).
      await invoke<string>('test_connection', { provider, model: probeModel, baseUrl: isCustom ? baseUrlInput.trim() : p?.api || '', apiKey: keyInput })
      toast.success('Connection OK')
    } catch (e) { toast.error(String(e)) }
    setTesting(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh]" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl w-[540px] max-h-[80vh] overflow-hidden shadow-[0_25px_50px_-12px_rgba(0,0,0,0.4)]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <div className="flex items-center gap-3">
            <h2 className="text-[13px] font-semibold text-foreground">Settings</h2>
            <div className="flex gap-1">
              {(['ai', 'appearance', 'git', 'system'] as const).filter(s => s !== 'system' || !isTauri).map(s => (
                <button key={s} onClick={() => setSection(s)}
                  className={'text-xs px-2 py-1 rounded cursor-pointer bg-transparent border-none ' + (section === s ? 'bg-surface-active text-foreground' : 'text-muted hover:text-foreground-secondary')}>
                  {s === 'ai' ? 'AI' : s === 'appearance' ? 'Appearance' : s === 'git' ? 'Git' : 'System'}
                </button>
              ))}
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded cursor-pointer bg-transparent text-muted border-none hover:text-foreground-secondary"><X size={16} /></button>
        </div>
        <div className="overflow-y-auto max-h-[calc(80vh-60px)] p-4">
          {section === 'ai' ? (
            <>
          <div className="text-xs text-muted mb-4 leading-relaxed">
            API keys are stored in {isTauri ? 'your macOS Keychain' : 'a server-side file (0600 perms)'}.
            {savedProviders.length > 0 && <span className="block mt-1 text-accent">✓ {savedProviders.length} provider{savedProviders.length > 1 ? 's' : ''} configured</span>}
          </div>

          {/* Provider */}
          <label className="text-xs font-medium text-foreground mb-1.5 block">Provider</label>
          <div ref={providerRef} className={'relative ' + (provider ? 'mb-3' : 'mb-5')}>
            <div onClick={() => { 
                const r = providerRef.current?.getBoundingClientRect()
                if (r) setProviderDropdownPos({ position: 'fixed', top: r.bottom + 4, left: r.left, right: window.innerWidth - r.right, width: r.width })
                setShowProviderDropdown(o => !o); setTimeout(() => searchRef.current?.focus(), 50) 
              }}
              className={'flex items-center gap-2 bg-background border border-border rounded-md px-3 py-[7px] cursor-pointer text-[13px] ' + (provider ? 'text-foreground' : 'text-muted')}>
              <span className="flex-1 flex items-center gap-2">
                {selectedProvider ? <span>{selectedProvider.name}</span> : '— Select a provider —'}
                {selectedProvider && isTextOnlyProvider(selectedProvider.id, model, probeTools) && <TextOnlyBadge />}
                {selectedProvider && savedSet.has(selectedProvider.id) && <Check size={12} />}
              </span>
              <ChevronsUpDown size={14} className="text-muted shrink-0" />
            </div>
            {showProviderDropdown && providerDropdownPos && (
              <div style={providerDropdownPos} className="max-h-[280px] bg-surface border border-border rounded-lg z-[200] shadow-[0_8px_24px_rgba(0,0,0,0.3)] overflow-clip">
                <div className="px-2 py-1.5 border-b border-border-subtle flex items-center gap-1.5">
                  <Search size={14} className="text-muted shrink-0" />
                  <input ref={searchRef} type="text" value={providerSearch} onChange={e => { setProviderSearch(e.target.value); setProviderHighlightIdx(0) }}
                    onKeyDown={e => {
                      if (e.key === 'ArrowDown') { e.preventDefault(); setProviderHighlightIdx(i => Math.min(i + 1, filteredProviders.length - 1)) }
                      if (e.key === 'ArrowUp') { e.preventDefault(); setProviderHighlightIdx(i => Math.max(i - 1, 0)) }
                      if (e.key === 'Enter' && filteredProviders[providerHighlightIdx]) { e.preventDefault(); selectProviderFn(filteredProviders[providerHighlightIdx]) }
                      if (e.key === 'Escape') { e.preventDefault(); setShowProviderDropdown(false) }
                    }}
                    placeholder="Search providers..." className="w-full bg-transparent border-none outline-none text-xs text-foreground" />
                </div>
                <div ref={providerListRef} className="max-h-[240px] overflow-y-auto">
                  {filteredProviders.length === 0 ? <div className="py-4 px-3 text-xs text-muted text-center">No providers found</div> : filteredProviders.map((p, i) => (
                    <div key={p.id} onClick={() => selectProviderFn(p)}
                      className={'flex items-center gap-2 px-3 py-[7px] cursor-pointer text-[13px] ' + (provider === p.id ? 'bg-accent text-white' : i === providerHighlightIdx ? 'bg-surface-active text-foreground-secondary' : 'text-foreground-secondary')}>
                      <span className="flex-1">{p.name}</span>
                      {isTextOnlyProvider(p.id, model, probeTools) && <TextOnlyBadge />}
                      {savedSet.has(p.id) && <Check size={12} />}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Model / custom endpoint */}
          {selectedProvider && (
            <>
              {isCustom ? (
                <>
                  <label className="text-xs font-medium text-foreground mb-1.5 block">Base URL{envCustom && envBadge}</label>
                  <input type="text" value={envCustom ? customCfg?.baseUrl ?? '' : baseUrlInput} onChange={e => setBaseUrlInput(e.target.value)} readOnly={envCustom}
                    placeholder="https://proxy.example.com/v1 — OpenAI-compatible endpoint"
                    className="w-full bg-background border border-border rounded-md px-3 py-[7px] text-xs text-foreground outline-none font-mono mb-3 disabled:opacity-60" />
                  <label className="text-xs font-medium text-foreground mb-1.5 block">Model{envCustom && customCfg?.model && envBadge}</label>
                  <input type="text" value={envCustom ? customCfg?.model ?? model : model} onChange={e => setModel(e.target.value)} readOnly={envCustom}
                    placeholder="model id, e.g. gpt-oss-20b or llama3.1:8b"
                    className="w-full bg-background border border-border rounded-md px-3 py-[7px] text-xs text-foreground outline-none font-mono mb-3 disabled:opacity-60" />
                </>
              ) : (
                <>
                  <label className="text-xs font-medium text-foreground mb-1.5 block">Model</label>
                  <div ref={modelRef} className="relative mb-3">
                <div onClick={() => { 
                    const r = modelRef.current?.getBoundingClientRect()
                    if (r) setModelDropdownPos({ position: 'fixed', top: r.bottom + 4, left: r.left, right: window.innerWidth - r.right, width: r.width })
                    setShowModelDropdown(o => !o); setTimeout(() => modelSearchRef.current?.focus(), 50) 
                  }}
                  className="flex items-center gap-2 bg-background border border-border rounded-md px-3 py-[7px] cursor-pointer text-[13px] text-foreground">
                  {model ? (() => {
                    const m = selectedProvider.models.find(x => x.id === model)
                    return m ? `${m.name} ($${m.costInput}/$${m.costOutput}, ${(m.context/1000).toFixed(0)}K ctx)` : model
                  })() : <span className="text-muted">— Select a model —</span>}
                  <ChevronsUpDown size={14} className="text-muted shrink-0 ml-auto" />
                </div>
                {showModelDropdown && modelDropdownPos && (
                  <div style={modelDropdownPos} className="max-h-[240px] bg-surface border border-border rounded-lg z-[200] shadow-[0_8px_24px_rgba(0,0,0,0.3)] overflow-clip">
                    <div className="px-2 py-1.5 border-b border-border-subtle flex items-center gap-1.5">
                      <Search size={14} className="text-muted shrink-0" />
                      <input ref={modelSearchRef} type="text" value={modelSearch} onChange={e => { setModelSearch(e.target.value); setModelHighlightIdx(0) }}
                        onKeyDown={e => {
                          const filtered = selectedProvider.models.filter(m => !modelSearch || m.name.toLowerCase().includes(modelSearch.toLowerCase()) || m.id.toLowerCase().includes(modelSearch.toLowerCase()))
                          if (e.key === 'ArrowDown') { e.preventDefault(); setModelHighlightIdx(i => Math.min(i + 1, filtered.length - 1)) }
                          if (e.key === 'ArrowUp') { e.preventDefault(); setModelHighlightIdx(i => Math.max(i - 1, 0)) }
                          if (e.key === 'Enter' && filtered[modelHighlightIdx]) { e.preventDefault(); setModel(filtered[modelHighlightIdx].id); setShowModelDropdown(false) }
                          if (e.key === 'Escape') { e.preventDefault(); setShowModelDropdown(false) }
                        }}
                        placeholder="Search models..." className="w-full bg-transparent border-none outline-none text-xs text-foreground" />
                    </div>
                    <div ref={modelListRef} className="max-h-[200px] overflow-y-auto">
                      {(() => {
                        const filtered = selectedProvider.models.filter(m => !modelSearch || m.name.toLowerCase().includes(modelSearch.toLowerCase()) || m.id.toLowerCase().includes(modelSearch.toLowerCase()))
                        return filtered.length === 0 ? <div className="py-4 px-3 text-xs text-muted text-center">No models found</div> : filtered.map((m, i) => (
                          <div key={m.id} onClick={() => { setModel(m.id); setShowModelDropdown(false) }}
                            className={'flex items-center gap-2 px-3 py-[7px] cursor-pointer text-xs font-mono ' + (m.id === model ? 'bg-accent text-white' : i === modelHighlightIdx ? 'bg-surface-active text-foreground-secondary' : 'text-foreground-secondary')}>
                            <span className="flex-1">{m.id}</span>
                            <span className="text-[10px] opacity-70">${m.costInput}/${m.costOutput} · {(m.context/1000).toFixed(0)}K</span>
                          </div>
                        ))
                      })()}
                    </div>
                  </div>
                )}
              </div>
                </>
              )}

              {/* API Key */}
              <label className="text-xs font-medium text-foreground mb-1.5 block">API Key{envCustom && envBadge}</label>
              <div className="flex gap-2 mb-2">
                <div className="relative flex-1">
                  <input type={showKey ? 'text' : 'password'} value={keyInput} onChange={e => setKeyInput(e.target.value)} readOnly={envCustom} placeholder={envCustom ? 'Key provided by environment' : (savedSet.has(provider) ? 'Key saved — type a new key to replace it' : 'sk-...')}
                    className="w-full bg-background border border-border rounded-md pl-3 pr-10 py-[7px] text-xs text-foreground outline-none font-mono disabled:opacity-60" />
                  <button onClick={() => setShowKey(v => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 bg-transparent border-none text-muted cursor-pointer p-1 hover:text-foreground-secondary">
                    {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                <button onClick={handleSave} disabled={!keyInput || saving || envCustom || (isCustom && !baseUrlInput.trim())}
                  className="px-3.5 py-[7px] text-xs rounded-md bg-surface-hover text-foreground border-none whitespace-nowrap flex items-center gap-1 cursor-pointer disabled:opacity-40 disabled:cursor-default">
                  {saving ? <Loader size={12} className="animate-spin" /> : <Check size={12} />}
                  {saving ? '...' : (savedSet.has(provider) ? 'Update' : 'Save')}
                </button>
                <button onClick={handleTest} disabled={(!keyInput && !envCustom) || testing || (isCustom && !baseUrlInput.trim() && !envCustom)}
                  className="px-3.5 py-[7px] text-xs rounded-md bg-accent text-white border-none whitespace-nowrap flex items-center gap-1 cursor-pointer disabled:opacity-40 disabled:cursor-default">
                  {testing ? <Loader size={12} className="animate-spin" /> : null}
                  {testing ? 'Testing...' : 'Test'}
                </button>
              </div>
              {savedSet.has(provider) && <div className="mb-2">
                <button onClick={async () => {
                  try { await invoke('delete_api_key', { provider }); clearApiKey(provider); removeSavedProvider(provider); toast.success('API key revoked') }
                  catch (e) { toast.error(String(e)) }
                }}
                  className="px-2.5 py-1 text-[11px] rounded bg-transparent text-danger border border-danger cursor-pointer">
                  Revoke API Key
                </button>
              </div>}
              {selectedProvider.api && <div className="text-[10px] text-muted font-mono mb-1">Base URL: {selectedProvider.api}</div>}
            </>
          )}
            </>
          ) : section === 'appearance' ? (
            <AppearanceSettings />
          ) : section === 'system' ? (
            <SystemSettings />
          ) : (
            <GitSettings />
          )}
        </div>
      </div>
    </div>
  )
}
