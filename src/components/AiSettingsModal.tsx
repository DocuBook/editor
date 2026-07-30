import { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { X, Eye, EyeOff, Check, Loader, ChevronsUpDown, Search } from 'lucide-react'
import { PROVIDERS, getDefaultModel, type ProviderInfo } from '../data/providers'
import { useAiSettings } from '../stores/aiSettings'

export default function AiSettingsModal({ onClose }: { onClose: () => void }) {
  const { provider, model, apiKey, savedProviders,
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

  // Check keychain for saved providers checkmarks (async, doesn't block)
  useEffect(() => {
    (async () => {
      for (const id of PROVIDERS.map(p => p.id)) {
        try {
          const k = await invoke<string>('get_api_key', { provider: id })
          if (k) addSavedProvider(id)
        } catch {}
      }
    })()
  }, [])

  // Load apiKey from keychain when switching to a provider with no stored key
  useEffect(() => {
    if (apiKey || !provider) return
    invoke<string>('get_api_key', { provider }).then(k => { if (k) { setApiKey(k); return } }).catch(() => {})
  }, [provider])

  // Scroll highlighted provider into view on keyboard navigation
  useEffect(() => {
    if (!showProviderDropdown) return
    const el = providerListRef.current?.children[providerHighlightIdx] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [providerHighlightIdx, showProviderDropdown])

  // Scroll highlighted model into view on keyboard navigation
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
    setProvider(p.id)
    setModel(getDefaultModel(p.id) || '')
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
      <div style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 12, width: 540, maxHeight: '80vh', overflow: 'hidden', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.4)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
          <h2 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>AI Providers</h2>
          <button onClick={onClose} style={{ padding: 6, borderRadius: 4, cursor: 'pointer', background: 'transparent', color: 'var(--text-muted)', border: 'none' }}><X size={16} /></button>
        </div>
        <div style={{ overflowY: 'auto', maxHeight: 'calc(80vh - 60px)', padding: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16, lineHeight: 1.5 }}>
            API keys are stored in your macOS Keychain.
            {savedProviders.length > 0 && <span style={{ display: 'block', marginTop: 4, color: 'var(--accent)' }}>✓ {savedProviders.length} provider{savedProviders.length > 1 ? 's' : ''} configured</span>}
          </div>

          {/* Provider */}
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 6, display: 'block' }}>Provider</label>
          <div ref={providerRef} style={{ position: 'relative', marginBottom: provider ? 12 : 20 }}>
            <div onClick={() => { 
                const r = providerRef.current?.getBoundingClientRect()
                if (r) setProviderDropdownPos({ position: 'fixed', top: r.bottom + 4, left: r.left, right: window.innerWidth - r.right, width: r.width })
                setShowProviderDropdown(o => !o); setTimeout(() => searchRef.current?.focus(), 50) 
              }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 12px', cursor: 'pointer', fontSize: 13, color: provider ? 'var(--text-primary)' : 'var(--text-muted)' }}>
              <span style={{ flex: 1 }}>{selectedProvider ? selectedProvider.name + (savedSet.has(selectedProvider.id) ? ' ✓' : '') : '— Select a provider —'}</span>
              <ChevronsUpDown size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
            </div>
            {showProviderDropdown && providerDropdownPos && (
              <div style={{ ...providerDropdownPos, maxHeight: 280, backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, zIndex: 200, boxShadow: '0 8px 24px rgba(0,0,0,0.3)', overflow: 'clip' }}>
                <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Search size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                  <input ref={searchRef} type="text" value={providerSearch} onChange={e => { setProviderSearch(e.target.value); setProviderHighlightIdx(0) }}
                    onKeyDown={e => {
                      if (e.key === 'ArrowDown') { e.preventDefault(); setProviderHighlightIdx(i => Math.min(i + 1, filteredProviders.length - 1)) }
                      if (e.key === 'ArrowUp') { e.preventDefault(); setProviderHighlightIdx(i => Math.max(i - 1, 0)) }
                      if (e.key === 'Enter' && filteredProviders[providerHighlightIdx]) { e.preventDefault(); selectProviderFn(filteredProviders[providerHighlightIdx]) }
                      if (e.key === 'Escape') { e.preventDefault(); setShowProviderDropdown(false) }
                    }}
                    placeholder="Search providers..." style={{ width: '100%', background: 'transparent', border: 'none', outline: 'none', fontSize: 12, color: 'var(--text-primary)' }} />
                </div>
                <div ref={providerListRef} style={{ maxHeight: 240, overflowY: 'auto' }}>
                  {filteredProviders.length === 0 ? <div style={{ padding: '16px 12px', fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>No providers found</div> : filteredProviders.map((p, i) => (
                    <div key={p.id} onClick={() => selectProviderFn(p)}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)', ...(provider === p.id ? { backgroundColor: 'var(--accent)', color: '#fff' } : i === providerHighlightIdx ? { backgroundColor: 'var(--bg-hover)' } : {}) }}>
                      <span style={{ flex: 1 }}>{p.name}</span>
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
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 6, display: 'block' }}>Model</label>
              <div ref={modelRef} style={{ position: 'relative', marginBottom: 12 }}>
                <div onClick={() => { 
                    const r = modelRef.current?.getBoundingClientRect()
                    if (r) setModelDropdownPos({ position: 'fixed', top: r.bottom + 4, left: r.left, right: window.innerWidth - r.right, width: r.width })
                    setShowModelDropdown(o => !o); setTimeout(() => modelSearchRef.current?.focus(), 50) 
                  }}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 12px', cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)' }}>
                  {model ? (() => {
                    const m = selectedProvider.models.find(x => x.id === model)
                    return m ? `${m.name} ($${m.costInput}/$${m.costOutput}, ${(m.context/1000).toFixed(0)}K ctx)` : model
                  })() : <span style={{ color: 'var(--text-muted)' }}>— Select a model —</span>}
                  <ChevronsUpDown size={14} style={{ color: 'var(--text-muted)', flexShrink: 0, marginLeft: 'auto' }} />
                </div>
                {showModelDropdown && modelDropdownPos && (
                  <div style={{ ...modelDropdownPos, maxHeight: 240, backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, zIndex: 200, boxShadow: '0 8px 24px rgba(0,0,0,0.3)', overflow: 'clip' }}>
                    <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Search size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                      <input ref={modelSearchRef} type="text" value={modelSearch} onChange={e => { setModelSearch(e.target.value); setModelHighlightIdx(0) }}
                        onKeyDown={e => {
                          const filtered = selectedProvider.models.filter(m => !modelSearch || m.name.toLowerCase().includes(modelSearch.toLowerCase()) || m.id.toLowerCase().includes(modelSearch.toLowerCase()))
                          if (e.key === 'ArrowDown') { e.preventDefault(); setModelHighlightIdx(i => Math.min(i + 1, filtered.length - 1)) }
                          if (e.key === 'ArrowUp') { e.preventDefault(); setModelHighlightIdx(i => Math.max(i - 1, 0)) }
                          if (e.key === 'Enter' && filtered[modelHighlightIdx]) { e.preventDefault(); setModel(filtered[modelHighlightIdx].id); setShowModelDropdown(false) }
                          if (e.key === 'Escape') { e.preventDefault(); setShowModelDropdown(false) }
                        }}
                        placeholder="Search models..." style={{ width: '100%', background: 'transparent', border: 'none', outline: 'none', fontSize: 12, color: 'var(--text-primary)' }} />
                    </div>
                    <div ref={modelListRef} style={{ maxHeight: 200, overflowY: 'auto' }}>
                      {(() => {
                        const filtered = selectedProvider.models.filter(m => !modelSearch || m.name.toLowerCase().includes(modelSearch.toLowerCase()) || m.id.toLowerCase().includes(modelSearch.toLowerCase()))
                        return filtered.length === 0 ? <div style={{ padding: '16px 12px', fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>No models found</div> : filtered.map((m, i) => (
                          <div key={m.id} onClick={() => { setModel(m.id); setShowModelDropdown(false) }}
                            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', cursor: 'pointer', fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'monospace', ...(m.id === model ? { backgroundColor: 'var(--accent)', color: '#fff' } : i === modelHighlightIdx ? { backgroundColor: 'var(--bg-hover)' } : {}) }}>
                            <span style={{ flex: 1 }}>{m.id}</span>
                            <span style={{ fontSize: 10, opacity: 0.7 }}>${m.costInput}/${m.costOutput} · {(m.context/1000).toFixed(0)}K</span>
                          </div>
                        ))
                      })()}
                    </div>
                  </div>
                )}
              </div>

              {/* API Key */}
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 6, display: 'block' }}>API Key</label>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <div style={{ position: 'relative', flex: 1 }}>
                  <input type={showKey ? 'text' : 'password'} value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-..."
                    style={{ width: '100%', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 40px 7px 12px', fontSize: 12, color: 'var(--text-primary)', outline: 'none', fontFamily: 'monospace' }} />
                  <button onClick={() => setShowKey(v => !v)}
                    style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4 }}>
                    {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                <button onClick={handleSave} disabled={!apiKey || saving}
                  style={{ padding: '7px 14px', fontSize: 12, borderRadius: 6, background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: 'none', cursor: saving ? 'default' : 'pointer', opacity: !apiKey || saving ? 0.4 : 1, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 4 }}>
                  {saving ? <Loader size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={12} />}
                  {saving ? '...' : (savedSet.has(provider) ? 'Update' : 'Save')}
                </button>
                <button onClick={handleTest} disabled={!apiKey || testing}
                  style={{ padding: '7px 14px', fontSize: 12, borderRadius: 6, background: '#3b82f6', color: '#fff', border: 'none', cursor: testing ? 'default' : 'pointer', opacity: !apiKey || testing ? 0.4 : 1, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 4 }}>
                  {testing ? <Loader size={12} style={{ animation: 'spin 1s linear infinite' }} /> : null}
                  {testing ? 'Testing...' : 'Test'}
                </button>
              </div>
              {savedSet.has(provider) && <div style={{ marginBottom: 8 }}>
                <button onClick={async () => {
                  try { await invoke('delete_api_key', { provider }); clearApiKey(provider); removeSavedProvider(provider); toast.success('API key revoked') }
                  catch (e) { toast.error(String(e)) }
                }}
                  style={{ padding: '4px 10px', fontSize: 11, borderRadius: 4, background: 'transparent', color: '#ef4444', border: '1px solid #ef4444', cursor: 'pointer' }}>
                  Revoke API Key
                </button>
              </div>}
              {selectedProvider && <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace', marginBottom: 4 }}>Base URL: {selectedProvider.api}</div>}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
