import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { invoke, isTauri } from '../lib/ipc'
import { toast } from 'sonner'
import { X, Eye, EyeOff, Check, Loader, RefreshCw, ChevronsUpDown } from 'lucide-react'
import { useAiSettings, CUSTOM_PROVIDER_ID, fetchAiSettings, setSavedProviders, type BackendAiSettings, type BackendEndpoint } from '../stores/aiSettings'
import { resolveProbeModel, autoProbe, isTextOnly } from '../utils/aiProbe'
import GitSettings from './GitSettings'
import SystemSettings from './SystemSettings'
import AppearanceSettings from './AppearanceSettings'
import { PROVIDERS } from '../data/providers'
import type { ProviderInfo } from '../data/providers'
import { fetchProviderModels, type DiscoveredModel } from '../utils/modelDiscovery'

/** Synthetic provider for user-configured OpenAI-compatible endpoints — NOT in the
 *  manual provider list. Base URL + key are bound server-side via set_custom_endpoint. */
const CUSTOM_PROVIDER: ProviderInfo = { id: CUSTOM_PROVIDER_ID, name: 'OpenAI Compatible (Custom)', api: '' }
const providers = [CUSTOM_PROVIDER, ...PROVIDERS]

/** Badge for providers currently on the text-only path (no tool-call
 *  streaming). Source of truth is the measured probe (aiSettings.probeTools)
 *  and the SAME rule the transport applies (aiProbe.isTextOnly): probe true →
 *  tools; probe false OR unmeasured → text-only. Sharing the helper matters
 *  because a badge that claims tools while the transport withholds them is a
 *  lie the user only discovers when documents stop being edited. */
const TextOnlyBadge = ({ measured = true }: { measured?: boolean }) => (
  <span
    title={
      measured
        ? "Measured: this model rejects the tool-call payload, so AI writes via markdown → suggestion"
        : "Not measured yet — AI writes via markdown → suggestion until a probe confirms tool-call support"
    }
    className="text-[9px] uppercase tracking-wide px-1 py-px rounded bg-surface-active text-muted border border-border-subtle shrink-0">
    text-only
  </span>
)

/** Read-only / locked field treatment. Inline style, not a Tailwind class: the
 *  app's own `input` base style (frontend/index.css) is unlayered, so it beats
 *  Tailwind's layered utilities no matter the class order — a locked field would
 *  otherwise keep the normal input background and look editable. */
const LOCKED_FIELD: React.CSSProperties = { background: 'var(--color-surface-active)', cursor: 'not-allowed' }
/** Whether a probe result already exists for this provider+model. Drives the
 *  cosmetic difference between "measured, no tools" and "not measured yet" —
 *  both are text-only, but only the latter is worth re-probing. */
const isProbed = (id: string, model: string, probeTools: Record<string, Record<string, boolean>>) =>
  !!model && probeTools[id]?.[model] !== undefined

/** A provider is CONFIGURED when the backend reports a key for it. That is the
 *  state machine's single input: configured → fields render the fetched values
 *  read-only and only Revoke is offered. */
const hasBackendKey = (cfg: BackendAiSettings | null, provider: string): boolean =>
  !!provider && !!cfg && (Object.prototype.hasOwnProperty.call(cfg.endpoints, provider) || cfg.savedProviders.includes(provider))

/** What a configured provider's fields are locked to: the endpoint the backend
 *  stored, with `env` (custom provider only) overriding it — the env vars win
 *  server-side, so showing anything else would describe a connection that is
 *  not the one being used. */
const lockedEndpoint = (cfg: BackendAiSettings | null, provider: string, isCustom: boolean): BackendEndpoint | null => {
  if (!cfg) return null
  if (isCustom && cfg.env) return { baseUrl: cfg.env.baseUrl, model: cfg.env.model, probes: {}, hasKey: cfg.env.hasKey }
  return cfg.endpoints[provider] ?? null
}

const isCustomProvider = (provider: string) => provider === CUSTOM_PROVIDER_ID

/** Store a probe result in the UI state AND on the backend. The write is explicit:
 *  the implicit mirror the store used to run is gone, and a probe is worth
 *  keeping server-side because re-measuring costs a round-trip while an unmeasured
 *  model runs text-only. Failure is non-fatal — the local record still holds. */
async function storeProbe(provider: string, model: string, tools: boolean): Promise<void> {
  useAiSettings.getState().setProbeTools(provider, model, tools)
  try {
    await invoke('set_probe', { provider, model, tools })
  } catch { /* probe stays local until the next successful write */ }
}

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<'ai' | 'appearance' | 'git' | 'system'>('ai')
  const { provider, model, savedProviders, probeTools,
    setProvider, setModel, clearApiKey, removeSavedProvider } = useAiSettings()

  /** API key is entered here but NEVER read back from the backend —
   *  the key stays in the keychain (SEC-5: keys are backend-only). */
  const [keyInput, setKeyInput] = useState('')
  const keyInputRef = useRef(keyInput)

  /** Custom base URL for the OpenAI-compatible provider
   *  (the backend owns the persisted copy; this is the input buffer). */
  const [baseUrlInput, setBaseUrlInput] = useState('')
  const baseUrlInputRef = useRef(baseUrlInput)

  /** The backend's answer, fetched — NOT snapshotted from the store on mount. The
   *  store read is what made the input column render empty when hydration
   *  resolved after mount, and it never survived a browser session that had no
   *  localStorage. This copy also drives the lock state machine below. */
  const [backendCfg, setBackendCfg] = useState<BackendAiSettings | null>(null)
  const [backendLoading, setBackendLoading] = useState(true)
  /** Custom provider config from the backend — source "env" means Docker
   *  overrides via DB_OPENAI_COMPAT_* → the UI renders read-only. */
  const [customCfg, setCustomCfg] = useState<{ source: string; baseUrl?: string; hasKey: boolean; model?: string } | null>(null)
  const refreshBackend = async () => {
    const [settings, custom] = await Promise.all([
      fetchAiSettings(),
      invoke<string>('custom_ai_config').catch(() => ''),
    ])
    if (custom) {
      try {
        const parsed = JSON.parse(custom)
        setCustomCfg(parsed)
        // Env model is forced — sync the store so transport + probe align.
        if (parsed.source === 'env' && parsed.model) useAiSettings.getState().setModel(parsed.model)
      } catch { /* keep the previous config rather than rendering a half-parsed one */ }
    }
    setBackendLoading(false)
    if (!settings) return
    setBackendCfg(settings)
    setSavedProviders(settings.savedProviders)
  }
  /* oxlint-disable react/set-state-in-effect -- initial async load from the backend */
  useEffect(() => { void refreshBackend() }, [])
  /* oxlint-enable react/set-state-in-effect */
  const envCustom = customCfg?.source === 'env'
  const envCustomRef = useRef(envCustom)
  const probeToolsRef = useRef(probeTools)
  /** Latest-value refs for async probes: synced after commit (never during
   *  render) and read only from callbacks. Declared before the auto-probe
   *  effect so the refs are fresh when it runs. */
  useEffect(() => {
    keyInputRef.current = keyInput
    baseUrlInputRef.current = baseUrlInput
    envCustomRef.current = envCustom
    probeToolsRef.current = probeTools
  })
  const envBadge = <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning-surface text-warning border border-warning-border ml-2">from env</span>

  const savedSet = new Set(savedProviders)
  /** Configured ≠ "this browser once typed a key": it means the backend holds one. */
  const configured = hasBackendKey(backendCfg, provider)
  const locked = configured || envCustom
  const stored = lockedEndpoint(backendCfg, provider, isCustomProvider(provider))
  /** Bumped after an explicit write so the auto-probe effect re-runs: a freshly
   *  saved endpoint has no measurement yet, and the effect's own dependencies
   *  (model/url) may not have changed since the save. */
  const [probeTick, setProbeTick] = useState(0)

  /** Auto-probe when the selected model changes and has no stored probe yet.
   *  Custom endpoints are text-only until measured true — a model switch would
   *  otherwise silently drop tool calls until a manual Test. The result is
   *  written back with an explicit `set_probe`: there is no implicit mirror path
   *  any more, and only a CONFIGURED provider has a key to probe with. */
  useEffect(() => {
    if (!provider || !model || !configured) return
    const p = providers.find(x => x.id === provider)
    const probeModel = resolveProbeModel(provider, model, envCustom ? customCfg?.model : undefined)
    if (!probeModel) return
    // Skip env-controlled custom: the probe must run against the env key/baseUrl
    // which the backend resolves — invoke with empty UI values lets it do that.
    void autoProbe(provider, probeModel, probeToolsRef.current, storeProbe, async () => {
      const result = await invoke<string>('test_connection', {
        provider,
        model: probeModel,
        // Configured providers probe with the BACKEND's endpoint values, not with
        // whatever this browser last typed into the (now read-only) inputs.
        baseUrl: provider === CUSTOM_PROVIDER_ID
          ? (stored?.baseUrl || (envCustomRef.current ? '' : baseUrlInputRef.current.trim()))
          : (stored?.baseUrl || p?.api || ''),
        apiKey: envCustomRef.current ? '' : keyInputRef.current,
      })
      try { const parsed = JSON.parse(result); if (typeof parsed.tools === 'boolean') return { tools: parsed.tools } } catch {}
      return undefined
    })
  }, [model, provider, configured, stored?.baseUrl, envCustom, customCfg?.model, probeTick])

  /** Provider catalog — small manual list (no more generated 2.17 MB file). */

  /** Runtime model discovery — fetched from the provider's /models via the
   *  backend (keyed server-side). Loading/error states drive the dropdown. */
  const [modelOptions, setModelOptions] = useState<DiscoveredModel[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  /* oxlint-disable react/set-state-in-effect -- resets the model list when the provider changes */
  useEffect(() => {
    if (!provider || provider === CUSTOM_PROVIDER_ID) { setModelOptions([]); setModelsError(null); return }
    const p = providers.find(x => x.id === provider)
    if (!p?.api) { setModelOptions([]); setModelsError(null); return }
    let cancelled = false
    setModelsLoading(true); setModelsError(null)
    fetchProviderModels(p.id, p.api)
      .then(models => {
        if (cancelled) return
        setModelOptions(models)
        // Seed a model only for a provider with NO endpoint on the backend (the
        // local-selection path). A configured provider's model comes from
        // hydration — defaulting here would fight the locked field.
        const st = useAiSettings.getState()
        if (models.length && !st.models[provider]) setModel(models[0].id)
      })
      .catch(e => { if (!cancelled) setModelsError(String(e)) })
      .finally(() => { if (!cancelled) setModelsLoading(false) })
    return () => { cancelled = true }
  }, [provider, setModel])
  /* oxlint-enable react/set-state-in-effect */

  const [showProviderDropdown, setShowProviderDropdown] = useState(false)
  const [showModelDropdown, setShowModelDropdown] = useState(false)
  const [providerDropdownPos, setProviderDropdownPos] = useState<React.CSSProperties | null>(null)
  const [modelDropdownPos, setModelDropdownPos] = useState<React.CSSProperties | null>(null)

  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  /** Total revoke is destructive (the key cannot be recovered), so it is confirmed. */
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  const cancelRevokeRef = useRef<HTMLButtonElement>(null)

  const providerRef = useRef<HTMLDivElement>(null)
  const modelRef = useRef<HTMLDivElement>(null)

  /** The dropdowns are rendered into document.body (see the createPortal calls
   *  below): .ui-dialog applies backdrop-filter, which makes it the containing
   *  block for position:fixed descendants, so dropdown coordinates taken from
   *  getBoundingClientRect would be offset by the dialog's own position. These
   *  refs keep the outside-click handlers aware of the portaled menus. */
  const providerDropdownRef = useRef<HTMLDivElement>(null)
  const modelDropdownRef = useRef<HTMLDivElement>(null)

  const selectedProvider: ProviderInfo | null = provider
    ? provider === CUSTOM_PROVIDER_ID ? CUSTOM_PROVIDER : providers.find(p => p.id === provider) || null
    : null
  const isCustom = provider === CUSTOM_PROVIDER_ID

  /** Seed the input buffers from the backend for the selected provider. These
   *  buffers are inputs only — they are not state, never persisted anywhere, and
   *  never read back by the transport: the backend owns the persisted copy. The
   *  seed does NOT depend on the model, or typing a model would be undone on the
   *  next refresh (it re-runs on every hydration). */
  /* oxlint-disable react/set-state-in-effect -- seeds the form from the fetched backend state */
  useEffect(() => {
    if (!provider) return
    setBaseUrlInput(lockedEndpoint(backendCfg, provider, isCustomProvider(provider))?.baseUrl || '')
  }, [backendCfg, provider])
  /* oxlint-enable react/set-state-in-effect */


  useEffect(() => {
    const h = (e: MouseEvent) => { const t = e.target as Node; if (providerRef.current && !providerRef.current.contains(t) && !providerDropdownRef.current?.contains(t)) { setShowProviderDropdown(false); setProviderDropdownPos(null) } }
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [])

  useEffect(() => {
    const h = (e: MouseEvent) => { const t = e.target as Node; if (modelRef.current && !modelRef.current.contains(t) && !modelDropdownRef.current?.contains(t)) { setShowModelDropdown(false); setModelDropdownPos(null) } }
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [])

  const selectProviderFn = (p: ProviderInfo) => {
    setProvider(p.id) // restores saved apiKey + model for this provider (model default is picked by the discovery effect above)
    setShowProviderDropdown(false)
  }

  const handleSave = async () => {
    if (!provider || !keyInput || (isCustom && !baseUrlInput.trim())) return
    setSaving(true)
    const p = providers.find(x => x.id === provider)
    const baseUrl = isCustom ? baseUrlInput.trim() : p?.api || ''
    // For env-controlled custom endpoints the probe must target the ENV model
    // (the backend sends it regardless of the UI value).
    const probeModel = resolveProbeModel(provider, model || modelOptions[0]?.id || '', envCustom ? customCfg?.model : undefined)
    try {
      /** Validate BEFORE persisting: the key must actually work against the
       *  SELECTED provider. Otherwise picking provider A + pasting provider B's
       *  key stores a dead key that fails at ask_ai time. */
      const result = await invoke<string>('test_connection', { provider, model: probeModel, baseUrl, apiKey: keyInput })
      let tools: boolean | undefined
      try { const parsed = JSON.parse(result); if (typeof parsed.tools === 'boolean') tools = parsed.tools } catch {}
      // test_connection resolved → key is valid for this provider. Persist.
      if (isCustom) {
        await invoke('set_custom_endpoint', { provider, baseUrl: baseUrlInput.trim(), key: keyInput, model: probeModel })
      } else {
        await invoke('set_api_key', { provider, key: keyInput, model: probeModel })
      }
      /** Persist measured tool-call support so the badge + transport use it (not
       *  the conservative unmeasured default) — an explicit set_probe, since no
       *  implicit mirror exists any more. ONE toast: the probe outcome is inline
       *  in the save confirmation, not a second toast stacking on top. */
      if (tools !== undefined) await storeProbe(provider, probeModel, tools)
      /** The saved endpoint becomes the source of truth for the locked fields, so
       *  the refresh is what locks them — never an assumption that the write
       *  landed as typed. */
      await refreshBackend()
      setKeyInput('')
      // Re-run the model-switch probe effect: a just-saved endpoint has no
      // measurement, and its inputs (model/url) may not have changed at all.
      setProbeTick(t => t + 1)
      if (tools !== undefined) {
        toast.success(tools === true ? 'API key saved - tool call' : 'API key saved - text-only')
      } else {
        toast.success('API key saved')
      }
    } catch (e) {
      /** Key rejected — do NOT persist. test_connection throws on auth/network
       *  failure, which means this key is wrong for the selected provider. */
      toast.error('API key rejected for this provider — check the key')
      console.error(e)
    }
    setSaving(false)
  }

  const handleTest = async () => {
    if (locked || !provider || !keyInput || (isCustom && !baseUrlInput.trim())) return
    setTesting(true)
    try {
      const p = providers.find(x => x.id === provider)
      const probeModel = resolveProbeModel(provider, model || modelOptions[0]?.id || '', envCustom ? customCfg?.model : undefined)
      // Test ONLY checks connectivity — it does not measure or persist tool-call
      // support (that's handleSave's probe and the model-switch effect).
      await invoke<string>('test_connection', { provider, model: probeModel, baseUrl: isCustom ? baseUrlInput.trim() : p?.api || '', apiKey: keyInput })
      toast.success('Connection OK')
    } catch (e) { toast.error(String(e)) }
    setTesting(false)
  }

  /** Total revoke: the backend drops the bound base URL, the model and the stored
   *  probes along with the key, and the browser cannot recover any of it. */
  const handleRevoke = async () => {
    if (!provider) return
    setConfirmRevoke(false)
    setSaving(true)
    try {
      await invoke('delete_api_key', { provider })
      clearApiKey(provider)
      removeSavedProvider(provider)
      setKeyInput('')
      /** Re-read the backend instead of trusting the local list: what is editable
       *  next is decided by what the server actually holds now. */
      await refreshBackend()
      toast.success('Provider revoked — API key and endpoint removed')
    } catch (e) { toast.error(String(e)) }
    setSaving(false)
  }

  /** A modal must be dismissible from the keyboard, not only by clicking it. */
  const cancelRevoke = () => {
    setConfirmRevoke(false)
    cancelRevokeRef.current?.focus()
  }

  return (
    <div data-testid="settings-modal" className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] max-sm:px-4 bg-overlay" onClick={onClose}>
      <div className="ui-dialog w-[540px] max-w-full max-h-[80vh] overflow-hidden" onClick={e => e.stopPropagation()}>
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
                setShowProviderDropdown(o => !o)
              }}
              className={'flex items-center gap-2 bg-background border border-border rounded-md px-3 py-[7px] cursor-pointer text-[13px] ' + (provider ? 'text-foreground' : 'text-muted')}>
              <span className="flex-1 flex items-center gap-2">
                {selectedProvider ? <span>{selectedProvider.name}</span> : '— Select a provider —'}
                {selectedProvider && isTextOnly(selectedProvider.id, model, probeTools) && (
                  <TextOnlyBadge measured={isProbed(selectedProvider.id, model, probeTools)} />
                )}
                {selectedProvider && savedSet.has(selectedProvider.id) && <Check size={12} />}
              </span>
              <ChevronsUpDown size={14} className="text-muted shrink-0" />
            </div>
            {showProviderDropdown && providerDropdownPos && createPortal(
              /* overflow-hidden, not Tailwind's overflow-clip: `overflow: clip` is
                 Safari 16+, and this minimised dropdown lists an option list whose
                 overflow escapes the 280px cap on Safari 15 (macOS 12). */
              <div ref={providerDropdownRef} style={providerDropdownPos} className="ui-popover max-h-[280px] z-[200] overflow-hidden">

                <div className="max-h-[240px] overflow-y-auto">
                  {providers.map((p) => (
                    <div key={p.id} onClick={() => selectProviderFn(p)}
                      className={'flex items-center gap-2 px-3 py-[7px] cursor-pointer text-[13px] ' + (provider === p.id ? 'bg-accent text-on-accent' : 'text-foreground-secondary hover:bg-surface-active')}>
                      <span className="flex-1">{p.name}</span>
                      {isTextOnly(p.id, model, probeTools) && (
                        <TextOnlyBadge measured={isProbed(p.id, model, probeTools)} />
                      )}
                      {savedSet.has(p.id) && <Check size={12} />}
                    </div>
                  ))}
                </div>
              </div>,
              document.body,
            )}
          </div>

          {/* Model / custom endpoint */}
          {selectedProvider && (
            <>
              {isCustom ? (
                <>
                  <label className="text-xs font-medium text-foreground mb-1.5 block">Base URL{envCustom && envBadge}</label>
                  {/* Unlocked, the field is an input buffer. Locked, it renders the
                      FETCHED endpoint: no buffer can drift from what the backend has. */}
                  {locked ? (
                    <input type="text" value={stored?.baseUrl || ''} readOnly aria-label="Base URL" style={LOCKED_FIELD}
                      className="w-full border border-border rounded-md px-3 py-[7px] text-xs outline-none font-mono mb-3 bg-background text-foreground" />
                  ) : (
                    <input type="text" value={baseUrlInput} onChange={e => setBaseUrlInput(e.target.value)} aria-label="Base URL"
                      placeholder="https://proxy.example.com/v1 — OpenAI-compatible endpoint"
                      className="w-full border border-border rounded-md px-3 py-[7px] text-xs outline-none font-mono mb-3 bg-background text-foreground" />
                  )}
                  <label className="text-xs font-medium text-foreground mb-1.5 block">Model{envCustom && customCfg?.model && envBadge}</label>
                  {locked ? (
                    <input type="text" value={stored?.model || ''} readOnly aria-label="Model" style={LOCKED_FIELD}
                      className="w-full border border-border rounded-md px-3 py-[7px] text-xs outline-none font-mono mb-3 bg-background text-foreground" />
                  ) : (
                    <input type="text" value={model} onChange={e => setModel(e.target.value)} aria-label="Model"
                      placeholder="model id, e.g. gpt-oss-20b or llama3.1:8b"
                      className="w-full border border-border rounded-md px-3 py-[7px] text-xs outline-none font-mono mb-3 bg-background text-foreground" />
                  )}
                </>
              ) : (
                <>
                  <label className="text-xs font-medium text-foreground mb-1.5 block">Model</label>

                  {/* While the backend fetch is in flight, the lock state is not yet
                      KNOWN — offering the picker here is what let a configured
                      provider look editable for a frame. */}
                  {backendLoading ? (
                    <input type="text" value="" readOnly placeholder="Loading…" style={LOCKED_FIELD} aria-label="Model"
                      className="w-full border border-border rounded-md px-3 py-[7px] text-xs text-foreground outline-none font-mono mb-3 bg-background" />
                  ) : locked ? (
                    /* Configured: the model is the backend's, so it renders as text
                       rather than a picker that could silently diverge from it. */
                    <input type="text" value={stored?.model || ''} readOnly style={LOCKED_FIELD} aria-label="Model"
                      className="w-full border border-border rounded-md px-3 py-[7px] text-xs text-foreground outline-none font-mono mb-3 bg-background" />
                  ) : modelsError ? (
                    <>
                      <input type="text" value={model} onChange={e => setModel(e.target.value)}
                        placeholder="model id, e.g. gpt-4o"
                        className="w-full bg-background border border-border rounded-md px-3 py-[7px] text-xs text-foreground outline-none font-mono mb-1 disabled:opacity-60" />
                      <div className="text-[10px] text-danger mb-3">Could not list models ({modelsError}) — type the model id manually.</div>
                    </>
                  ) : (
                  <div ref={modelRef} className="relative mb-3">
                <div onClick={() => { 
                    const r = modelRef.current?.getBoundingClientRect()
                    if (r) setModelDropdownPos({ position: 'fixed', top: r.bottom + 4, left: r.left, right: window.innerWidth - r.right, width: r.width })
                    setShowModelDropdown(o => !o)
                  }}
                  className="flex items-center gap-2 bg-background border border-border rounded-md px-3 py-[7px] cursor-pointer text-[13px] text-foreground">
                  {modelsLoading ? <span className="text-muted">Loading models…</span> : model ? (() => {
                    const m = modelOptions.find(x => x.id === model)
                    return m ? m.name : model
                  })() : <span className="text-muted">— Select a model —</span>}
                  <ChevronsUpDown size={14} className="text-muted shrink-0 ml-auto" />
                </div>
                {showModelDropdown && modelDropdownPos && createPortal(
                  <div ref={modelDropdownRef} style={modelDropdownPos} className="ui-popover max-h-[240px] z-[200] overflow-hidden">

                    <div className="max-h-[200px] overflow-y-auto">
                      {modelOptions.length === 0 ? <div className="py-4 px-3 text-xs text-muted text-center">{modelsError ? 'Could not load models' : 'No models found'}</div> : modelOptions.map((m) => (
                        <div key={m.id} onClick={() => { setModel(m.id); setShowModelDropdown(false) }}
                          className={'flex items-center gap-2 px-3 py-[7px] cursor-pointer text-xs font-mono ' + (m.id === model ? 'bg-accent text-on-accent' : 'text-foreground-secondary hover:bg-surface-active')}>
                          <span className="flex-1">{m.id}</span>
                        </div>
                      ))}
                    </div>
                  </div>,
                  document.body,
                )}
              </div>
                  )}
                </>
              )}

              {/* API Key. UNCONFIGURED: the field is the entry buffer, with Save
                  (validate → persist) and Test (connectivity only). CONFIGURED: the
                  field never holds a value — the backend does not hand keys back —
                  so it renders a "saved" placeholder and the ONLY write offered is
                  the confirmed total Revoke. */}
              {!locked && (
                <>
                  <label className="text-xs font-medium text-foreground mb-1.5 block">API Key</label>
                  <div className="flex gap-2 mb-2">
                    <div className="relative flex-1">
                      <input type={showKey ? 'text' : 'password'} value={keyInput} onChange={e => setKeyInput(e.target.value)} placeholder="sk-..." aria-label="API Key"
                        className="w-full bg-background border border-border rounded-md pl-3 pr-10 py-[7px] text-xs text-foreground outline-none font-mono" />
                      <button onClick={() => setShowKey(v => !v)} aria-label={showKey ? 'Hide API key' : 'Show API key'}
                        className="absolute right-2 top-1/2 -translate-y-1/2 bg-transparent border-none text-muted cursor-pointer p-1 hover:text-foreground-secondary">
                        {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                    <button onClick={handleSave} disabled={!keyInput || saving || (isCustom && !baseUrlInput.trim())}
                      className="px-3.5 py-[7px] text-xs rounded-md bg-accent text-on-accent border-none whitespace-nowrap flex items-center gap-1 cursor-pointer disabled:opacity-40 disabled:cursor-default">
                      {saving ? <Loader size={12} className="animate-spin" /> : <Check size={12} />}
                      {saving ? '...' : 'Save'}
                    </button>
                    <button onClick={handleTest} disabled={!keyInput || testing || (isCustom && !baseUrlInput.trim())}
                      aria-label="Check connection" title="Check connection"
                      className="p-[7px] rounded-md bg-success-surface text-success border border-success-border cursor-pointer flex items-center justify-center hover:bg-success hover:text-on-accent disabled:opacity-40 disabled:cursor-default">
                      {testing ? <Loader size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                      <span className="sr-only">Test</span>
                    </button>
                  </div>
                </>
              )}
              {locked && (
                <div className="mb-2">
                  <label className="text-xs font-medium text-foreground mb-1.5 block">API Key</label>
                  {/* One wrapper for the whole locked block: a click anywhere inside
                      it would otherwise be a click on the dialog's backdrop (the
                      overlay closes the modal on click), so the confirm dialog's
                      buttons would be swallowed before reaching them. */}
                  <div onClick={e => e.stopPropagation()}>
                  <div className="relative mb-2">
                    {/* Value is always empty: the key is backend-only (SEC-5). */}
                    <input type="password" value="" readOnly aria-label="API Key"
                      placeholder={envCustom ? 'Key provided by environment' : 'Saved — press Revoke to replace this key'}
                      style={LOCKED_FIELD}
                      className="w-full border border-border rounded-md px-3 py-[7px] text-xs text-foreground outline-none font-mono bg-background" />
                  </div>
                  <div className="text-[10px] text-muted mb-2 leading-relaxed">
                    This provider is configured, so its Base URL, Model and API Key are locked
                    {envCustom ? '.' : ' — the values shown are the ones the backend stored. Press Revoke to clear them, then enter new values.'}
                  </div>
                  {/* Env-controlled custom endpoints are not revocable from the UI:
                      the backend rejects edits while DB_OPENAI_COMPAT_* is set. */}
                  {!envCustom && (
                    <button onClick={() => setConfirmRevoke(true)} disabled={saving}
                      className="px-2.5 py-1 text-[11px] rounded bg-transparent text-danger border border-danger cursor-pointer disabled:opacity-40">
                      Revoke
                    </button>
                  )}
                  </div>
                </div>
              )}
              {selectedProvider.api && !locked && <div className="text-[10px] text-muted font-mono mb-1">Base URL: {selectedProvider.api}</div>}
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

      {confirmRevoke && (
        <div role="alertdialog" aria-modal="true" aria-label="Revoke provider" className="fixed inset-0 z-220 flex items-center justify-center bg-overlay"
          onClick={cancelRevoke} onKeyDown={e => { if (e.key === 'Escape') cancelRevoke() }}>
          <div className="ui-popover p-4 w-80" onClick={e => e.stopPropagation()}>
            <div className="text-sm font-semibold mb-1">Revoke {selectedProvider?.name ?? provider}?</div>
            <div className="text-xs text-foreground-secondary mb-2 break-all font-mono">{stored?.baseUrl || selectedProvider?.api || ''}</div>
            <div className="text-xs text-foreground-secondary mb-4">
              The API key is deleted on the server and cannot be recovered — it must be entered again to use this
              provider. Its saved Base URL, Model and probe results are removed with it, so the fields become editable
              again with no values filled in.
            </div>
            <div className="flex justify-end gap-2">
              <button ref={cancelRevokeRef} autoFocus onClick={cancelRevoke}
                className="px-3 py-1.5 rounded-md bg-transparent text-foreground-secondary border border-border cursor-pointer text-xs hover:bg-surface-active">Cancel</button>
              <button onClick={() => void handleRevoke()} disabled={saving}
                className="px-3 py-1.5 rounded-md bg-danger text-on-danger border-none cursor-pointer text-xs disabled:opacity-40">Revoke</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
