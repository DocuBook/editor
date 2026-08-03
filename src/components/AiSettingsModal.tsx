import { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { X, Eye, EyeOff, Check, Loader, ChevronsUpDown, Search } from 'lucide-react'
import { PROVIDERS, getDefaultModel, type ProviderInfo } from '../data/providers'
import { useAiSettings } from '../stores/aiSettings'

export default function AiSettingsModal({ onClose }: { onClose: () => void }) {
  const { provider, model, apiKey, savedProviders, models,
    setProvider, setModel, setApiKey, clearApiKey, addSavedProvider, removeSavedProvider } = useAiSettings()

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

  const selectedProvider: ProviderInfo | null = provider ? PROVIDERS.find(p => p.id === provider) || null : null
  const savedSet = new Set(savedProviders)

  /** Check keychain for saved providers and load keys into memory */
  useEffect(() => {
    (async () => {
      const current = useAiSettings.getState().provider
      for (const id of PROVIDERS.map(p => p.id)) {
        try {
          const k = await invoke<string>('get_api_key', { provider: id })
          if (k) {
            addSavedProvider(id)
            if (id === current) setApiKey(k)
          }
        } catch {}
      }
    })()
  }, [])

  /** Load apiKey from keychain when empty (startup, HMR, or provider switch) */
  useEffect(() => {
    if (apiKey || !provider) return
    invoke<string>('get_api_key', { provider }).then(k => { if (k) { setApiKey(k); return } }).catch(() => {})
  }, [provider, apiKey])

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

  const filteredProviders = PROVIDERS.filter(p =>
    !providerSearch || p.name.toLowerCase().includes(providerSearch.toLowerCase()) || p.id.toLowerCase().includes(providerSearch.toLowerCase())
  )

  const selectProviderFn = (p: ProviderInfo) => {
    setProvider(p.id) // restores saved apiKey + model for this provider
    if (!models[p.id]) setModel(getDefaultModel(p.id) || '') // only default if never chosen
    setShowProviderDropdown(false)
  }

  const handleSave = async () => {
    if (!provider || !apiKey) return
    setSaving(true)
    try {
      await invoke('set_api_key', { provider, key: apiKey })
      addSavedProvider(provider)
      toast.success('API key saved')
    } catch (e) { toast.error('Failed to save API key'); console.error(e) }
    setSaving(false)
  }

  const handleTest = async () => {
    if (!provider || !apiKey) return
    setTesting(true)
    try {
      const p = PROVIDERS.find(x => x.id === provider)
      await invoke<string>('test_connection', { provider, model: model || p?.models[0]?.id || '', baseUrl: p?.api || '', apiKey })
      toast.success('Connection OK')
    } catch (e) { toast.error(String(e)) }
    setTesting(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh]" onClick={onClose}>
      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl w-[540px] max-h-[80vh] overflow-hidden shadow-[0_25px_50px_-12px_rgba(0,0,0,0.4)]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-subtle)]">
          <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">AI Providers</h2>
          <button onClick={onClose} className="p-1.5 rounded cursor-pointer bg-transparent text-[var(--text-muted)] border-none hover:text-zinc-300"><X size={16} /></button>
        </div>
        <div className="overflow-y-auto max-h-[calc(80vh-60px)] p-4">
          <div className="text-xs text-[var(--text-muted)] mb-4 leading-relaxed">
            API keys are stored in your macOS Keychain.
            {savedProviders.length > 0 && <span className="block mt-1 text-[var(--accent)]">✓ {savedProviders.length} provider{savedProviders.length > 1 ? 's' : ''} configured</span>}
          </div>

          {/* Provider */}
          <label className="text-xs font-medium text-[var(--text-primary)] mb-1.5 block">Provider</label>
          <div ref={providerRef} className={'relative ' + (provider ? 'mb-3' : 'mb-5')}>
            <div onClick={() => { 
                const r = providerRef.current?.getBoundingClientRect()
                if (r) setProviderDropdownPos({ position: 'fixed', top: r.bottom + 4, left: r.left, right: window.innerWidth - r.right, width: r.width })
                setShowProviderDropdown(o => !o); setTimeout(() => searchRef.current?.focus(), 50) 
              }}
              className={'flex items-center gap-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-md px-3 py-[7px] cursor-pointer text-[13px] ' + (provider ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]')}>
              <span className="flex-1">{selectedProvider ? selectedProvider.name + (savedSet.has(selectedProvider.id) ? ' ✓' : '') : '— Select a provider —'}</span>
              <ChevronsUpDown size={14} className="text-[var(--text-muted)] shrink-0" />
            </div>
            {showProviderDropdown && providerDropdownPos && (
              <div style={providerDropdownPos} className="max-h-[280px] bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg z-[200] shadow-[0_8px_24px_rgba(0,0,0,0.3)] overflow-clip">
                <div className="px-2 py-1.5 border-b border-[var(--border-subtle)] flex items-center gap-1.5">
                  <Search size={14} className="text-[var(--text-muted)] shrink-0" />
                  <input ref={searchRef} type="text" value={providerSearch} onChange={e => { setProviderSearch(e.target.value); setProviderHighlightIdx(0) }}
                    onKeyDown={e => {
                      if (e.key === 'ArrowDown') { e.preventDefault(); setProviderHighlightIdx(i => Math.min(i + 1, filteredProviders.length - 1)) }
                      if (e.key === 'ArrowUp') { e.preventDefault(); setProviderHighlightIdx(i => Math.max(i - 1, 0)) }
                      if (e.key === 'Enter' && filteredProviders[providerHighlightIdx]) { e.preventDefault(); selectProviderFn(filteredProviders[providerHighlightIdx]) }
                      if (e.key === 'Escape') { e.preventDefault(); setShowProviderDropdown(false) }
                    }}
                    placeholder="Search providers..." className="w-full bg-transparent border-none outline-none text-xs text-[var(--text-primary)]" />
                </div>
                <div ref={providerListRef} className="max-h-[240px] overflow-y-auto">
                  {filteredProviders.length === 0 ? <div className="py-4 px-3 text-xs text-[var(--text-muted)] text-center">No providers found</div> : filteredProviders.map((p, i) => (
                    <div key={p.id} onClick={() => selectProviderFn(p)}
                      className={'flex items-center gap-2 px-3 py-[7px] cursor-pointer text-[13px] ' + (provider === p.id ? 'bg-[var(--accent)] text-[var(--white)]' : i === providerHighlightIdx ? 'bg-[var(--bg-hover)] text-[var(--text-secondary)]' : 'text-[var(--text-secondary)]')}>
                      <span className="flex-1">{p.name}</span>
                      {savedSet.has(p.id) && <Check size={12} />}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Model */}
          {selectedProvider && (
            <>
              <label className="text-xs font-medium text-[var(--text-primary)] mb-1.5 block">Model</label>
              <div ref={modelRef} className="relative mb-3">
                <div onClick={() => { 
                    const r = modelRef.current?.getBoundingClientRect()
                    if (r) setModelDropdownPos({ position: 'fixed', top: r.bottom + 4, left: r.left, right: window.innerWidth - r.right, width: r.width })
                    setShowModelDropdown(o => !o); setTimeout(() => modelSearchRef.current?.focus(), 50) 
                  }}
                  className="flex items-center gap-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-md px-3 py-[7px] cursor-pointer text-[13px] text-[var(--text-primary)]">
                  {model ? (() => {
                    const m = selectedProvider.models.find(x => x.id === model)
                    return m ? `${m.name} ($${m.costInput}/$${m.costOutput}, ${(m.context/1000).toFixed(0)}K ctx)` : model
                  })() : <span className="text-[var(--text-muted)]">— Select a model —</span>}
                  <ChevronsUpDown size={14} className="text-[var(--text-muted)] shrink-0 ml-auto" />
                </div>
                {showModelDropdown && modelDropdownPos && (
                  <div style={modelDropdownPos} className="max-h-[240px] bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg z-[200] shadow-[0_8px_24px_rgba(0,0,0,0.3)] overflow-clip">
                    <div className="px-2 py-1.5 border-b border-[var(--border-subtle)] flex items-center gap-1.5">
                      <Search size={14} className="text-[var(--text-muted)] shrink-0" />
                      <input ref={modelSearchRef} type="text" value={modelSearch} onChange={e => { setModelSearch(e.target.value); setModelHighlightIdx(0) }}
                        onKeyDown={e => {
                          const filtered = selectedProvider.models.filter(m => !modelSearch || m.name.toLowerCase().includes(modelSearch.toLowerCase()) || m.id.toLowerCase().includes(modelSearch.toLowerCase()))
                          if (e.key === 'ArrowDown') { e.preventDefault(); setModelHighlightIdx(i => Math.min(i + 1, filtered.length - 1)) }
                          if (e.key === 'ArrowUp') { e.preventDefault(); setModelHighlightIdx(i => Math.max(i - 1, 0)) }
                          if (e.key === 'Enter' && filtered[modelHighlightIdx]) { e.preventDefault(); setModel(filtered[modelHighlightIdx].id); setShowModelDropdown(false) }
                          if (e.key === 'Escape') { e.preventDefault(); setShowModelDropdown(false) }
                        }}
                        placeholder="Search models..." className="w-full bg-transparent border-none outline-none text-xs text-[var(--text-primary)]" />
                    </div>
                    <div ref={modelListRef} className="max-h-[200px] overflow-y-auto">
                      {(() => {
                        const filtered = selectedProvider.models.filter(m => !modelSearch || m.name.toLowerCase().includes(modelSearch.toLowerCase()) || m.id.toLowerCase().includes(modelSearch.toLowerCase()))
                        return filtered.length === 0 ? <div className="py-4 px-3 text-xs text-[var(--text-muted)] text-center">No models found</div> : filtered.map((m, i) => (
                          <div key={m.id} onClick={() => { setModel(m.id); setShowModelDropdown(false) }}
                            className={'flex items-center gap-2 px-3 py-[7px] cursor-pointer text-xs font-mono ' + (m.id === model ? 'bg-[var(--accent)] text-[var(--white)]' : i === modelHighlightIdx ? 'bg-[var(--bg-hover)] text-[var(--text-secondary)]' : 'text-[var(--text-secondary)]')}>
                            <span className="flex-1">{m.id}</span>
                            <span className="text-[10px] opacity-70">${m.costInput}/${m.costOutput} · {(m.context/1000).toFixed(0)}K</span>
                          </div>
                        ))
                      })()}
                    </div>
                  </div>
                )}
              </div>

              {/* API Key */}
              <label className="text-xs font-medium text-[var(--text-primary)] mb-1.5 block">API Key</label>
              <div className="flex gap-2 mb-2">
                <div className="relative flex-1">
                  <input type={showKey ? 'text' : 'password'} value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-..."
                    className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-md pl-3 pr-10 py-[7px] text-xs text-[var(--text-primary)] outline-none font-mono" />
                  <button onClick={() => setShowKey(v => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 bg-transparent border-none text-[var(--text-muted)] cursor-pointer p-1 hover:text-zinc-300">
                    {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                <button onClick={handleSave} disabled={!apiKey || saving}
                  className="px-3.5 py-[7px] text-xs rounded-md bg-[var(--bg-tertiary)] text-[var(--text-primary)] border-none whitespace-nowrap flex items-center gap-1 disabled:opacity-40 disabled:cursor-default">
                  {saving ? <Loader size={12} className="animate-spin" /> : <Check size={12} />}
                  {saving ? '...' : (savedSet.has(provider) ? 'Update' : 'Save')}
                </button>
                <button onClick={handleTest} disabled={!apiKey || testing}
                  className="px-3.5 py-[7px] text-xs rounded-md bg-[var(--accent)] text-[var(--white)] border-none whitespace-nowrap flex items-center gap-1 disabled:opacity-40 disabled:cursor-default">
                  {testing ? <Loader size={12} className="animate-spin" /> : null}
                  {testing ? 'Testing...' : 'Test'}
                </button>
              </div>
              {savedSet.has(provider) && <div className="mb-2">
                <button onClick={async () => {
                  try { await invoke('delete_api_key', { provider }); clearApiKey(provider); removeSavedProvider(provider); toast.success('API key revoked') }
                  catch (e) { toast.error(String(e)) }
                }}
                  className="px-2.5 py-1 text-[11px] rounded bg-transparent text-[var(--danger)] border border-[var(--danger)] cursor-pointer">
                  Revoke API Key
                </button>
              </div>}
              {selectedProvider && <div className="text-[10px] text-[var(--text-muted)] font-mono mb-1">Base URL: {selectedProvider.api}</div>}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
