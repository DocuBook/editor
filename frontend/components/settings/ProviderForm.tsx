import { useState, useEffect, useRef } from 'react'
import { invoke } from '../../lib/ipc'
import { toast } from 'sonner'
import { Eye, EyeOff, Check, Loader, RefreshCw } from 'lucide-react'
import { useAiSettings, CUSTOM_PROVIDER_ID, fetchAiSettingsShared, setSavedProviders, subscribeAiSettingsHydration, type BackendAiSettings, type BackendEndpoint } from '../../stores/aiSettings'
import { resolveProbeModel, ensureToolProbe, parseProbeResult, recordToolProbe, resetToolProbeBackoff } from '../../utils/aiProbe'
import { fetchProviderModels } from '../../utils/modelDiscovery'
import { FORM_DIVIDER_CLASS, FORM_DIVIDER_FIRST_CLASS } from './SettingsSection'
import { PROVIDERS } from '../../data/providers'
import type { ProviderInfo } from '../../data/providers'

/** Synthetic provider for user-configured OpenAI-compatible endpoints — NOT in the
 *  manual provider list. Base URL + key are bound server-side via set_custom_endpoint. */
const CUSTOM_PROVIDER: ProviderInfo = { id: CUSTOM_PROVIDER_ID, name: 'OpenAI Compatible', api: '' }
const providers = [CUSTOM_PROVIDER, ...PROVIDERS]

/** Read-only / locked field treatment. Inline style, not a Tailwind class: the
 *  app's own `input` base style (frontend/index.css) is unlayered, so it beats
 *  Tailwind's layered utilities no matter the class order — a locked field would
 *  otherwise keep the normal input background and look editable. */
const LOCKED_FIELD: React.CSSProperties = { background: 'var(--color-surface-active)', cursor: 'not-allowed' }

/** A provider is CONFIGURED when the backend reports a key for it. That is the
 *  state machine's single input: configured → fields render the fetched values
 *  read-only and only Revoke is offered. */
const hasBackendKey = (cfg: BackendAiSettings | null, provider: string): boolean =>
  !!provider && !!cfg && cfg.endpoints[provider]?.hasKey === true

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

/** Validate a freshly entered key without assuming a model: the catalog bakes in
 *  none, so a user who has not picked a model yet gets one DISCOVERED from the
 *  endpoint (`list_models` with the still-unsaved key). Returns '' when the
 *  endpoint exposes no usable model — the caller turns that into a next-step hint
 *  rather than sending an empty model the backend would reject. */
async function discoverModel(provider: string, customBaseUrl: string, key: string): Promise<string> {
  const baseUrl = customBaseUrl.trim() || PROVIDERS.find(p => p.id === provider)?.api || ''
  if (!baseUrl) return ''
  try {
    return (await fetchProviderModels(provider, baseUrl, key))[0]?.id ?? ''
  } catch { return '' }
}

/** The AI provider form — ONE provider's connection settings (base URL + API
 *  key + Model), pinned to `provider`. The MODEL field shows only while the
 *  provider is UNCONFIGURED: the composer's picker cannot list models before a
 *  key is saved, so this is the only place to name one for the first validation
 *  (leave it blank and a model is discovered from the endpoint). Once
 *  configured, the field is gone and the composer picker is the ONE model UI.
 *  Every provider section on the AI page renders its own instance: picking a
 *  provider in one section never changes what the others edit, and the pane's
 *  scroll target ("show me Opencode Go") lands on the right form even when the
 *  store's selection is another provider.
 *
 *  Duplicate backend reads are acceptable here — fetchAiSettings only READS
 *  config.json, and writes are guarded by the per-instance `saving` flag, so the
 *  instances never race on a mutation. Hidden instances (a collapsed/never
 *  mounted section) cost nothing, so each form holds only the state it shows.
 *
 *  The read itself goes through fetchAiSettingsShared, so the three instances
 *  mounting from one page open share ONE request instead of firing three — while
 *  each instance still holds only the state it renders. */
export default function ProviderForm({ provider, first }: { provider: string; first?: boolean }) {
  const { model, models, dirtySelection, forgetProvider } = useAiSettings()

  /** The store selection, READ here so the form can adopt a composer pick. The
   *  form's own locked-field values still come from its fetch of the backend, which
   *  is what the server actually holds — this subscription is only for the MODEL,
   *  whose single editable UI is the composer picker. */
  const storeProvider = useAiSettings(s => s.provider)
  const storeModel = useAiSettings(s => s.model)

  /** API key is entered here but NEVER read back from the backend —
   *  the key stays in the keychain (SEC-5: keys are backend-only). */
  const [keyInput, setKeyInput] = useState('')
  const keyInputRef = useRef(keyInput)

  /** Base URL for THIS provider (every provider has its own — the backend owns
   *  the persisted copy; this is the input buffer). */
  const [baseUrlInput, setBaseUrlInput] = useState('')
  const baseUrlInputRef = useRef(baseUrlInput)

  /** Model for THIS provider, entered in the form ONLY while it is unconfigured.
   *  The composer's picker needs a saved key to list models, so before the first
   *  save this form is the ONLY place a model can come from — otherwise the user
   *  is stuck: cannot save a key without a model, cannot pick a model without a
   *  key. Once configured, the field disappears and the composer owns selection
   *  (ONE model UI, no second source of truth). */
  const [modelInput, setModelInput] = useState('')
  const modelInputRef = useRef(modelInput)

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
      fetchAiSettingsShared(),
      invoke<string>('custom_ai_config').catch(() => ''),
    ])
    if (custom) {
      try {
        const parsed = JSON.parse(custom)
        setCustomCfg(parsed)
        // Env model is forced — sync the store so transport + probe align.
        if (parsed.source === 'env' && parsed.model) useAiSettings.getState().setModel(useAiSettings.getState().provider, parsed.model)
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
  useEffect(() => subscribeAiSettingsHydration(settings => {
    setBackendCfg(settings)
    setSavedProviders(settings.savedProviders)
  }), [])
  /** Window/tab focus does NOT refresh here any more: three instances meant three
   *  listener pairs, so the re-read moved to the app root (see App.tsx) where it
   *  runs once for the whole surface. */
  const envCustom = customCfg?.source === 'env'
  const envCustomRef = useRef(envCustom)
  /** Latest-value refs for async probes: synced after commit (never during
   *  render) and read only from callbacks. Declared before the auto-probe
   *  effect so the refs are fresh when it runs. */
  useEffect(() => {
    keyInputRef.current = keyInput
    baseUrlInputRef.current = baseUrlInput
    modelInputRef.current = modelInput
    envCustomRef.current = envCustom
  })
  const envBadge = <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning-surface text-warning border border-warning-border ml-2">from env</span>

  /** Configured ≠ "this browser once typed a key": it means the backend holds one. */
  const configured = hasBackendKey(backendCfg, provider)
  const locked = configured || envCustom
  const stored = lockedEndpoint(backendCfg, provider, isCustomProvider(provider))
  /** Bumped after an explicit write so the auto-probe effect re-runs: a freshly
   *  saved endpoint has no measurement yet, and the effect's own dependencies
   *  (model/url) may not have changed since the save. */
  const [probeTick, setProbeTick] = useState(0)

  /** This provider's own stored model. For the ACTIVE provider the store's `model`
   *  IS this value (kept in sync); for another form on the page it is that
   *  provider's row. Reading per-provider keeps every form on its own model: the
   *  live `model` belongs to the active provider only, and probing or saving
   *  another provider with it sent that provider a model it does not serve. */
  const providerModel = models[provider] || (useAiSettings.getState().provider === provider ? model : '') || ''

  /** Auto-probe THIS provider's model when it has no stored probe yet: unmeasured
   *  runs text-only. `ensureToolProbe` shares one request per provider+model with
   *  the composer and the transport, and probes with the backend's stored key
   *  and endpoint — only a CONFIGURED provider has a key to probe with. */
  useEffect(() => {
    if (!provider || !configured) return
    const probeModel = resolveProbeModel(provider, providerModel, envCustom ? customCfg?.model : undefined)
    if (probeModel) void ensureToolProbe(provider, probeModel)
  }, [providerModel, provider, configured, envCustom, customCfg?.model, probeTick])

  /** Runtime model discovery lives in the composer's model picker, not here: the
   *  model is ONE setting with ONE UI, so the form renders NO model control. */
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  /** Total revoke is destructive (the key cannot be recovered), so it is confirmed. */
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  const cancelRevokeRef = useRef<HTMLButtonElement>(null)

  const selectedProvider: ProviderInfo | null = provider
    ? provider === CUSTOM_PROVIDER_ID ? CUSTOM_PROVIDER : providers.find(p => p.id === provider) || null
    : null
  const isCustom = provider === CUSTOM_PROVIDER_ID


  /** A live composer pick for THIS provider, when this form's provider is the
   *  active one. `dirtySelection` marks that the pick is session-local and the
   *  backend has not been told yet, so the store — not the fetched config — is the
   *  fresher truth for the MODEL. The rest of the form (lock state, base URL)
   *  still follows the fetch, which is what the server actually holds. */
  const livePick = provider === storeProvider && dirtySelection ? storeModel : ''

  /** Seed the input buffers from the backend for THIS provider. These buffers are
   *  inputs only — they are not state, never persisted anywhere, and never read
   *  back by the transport: the backend owns the persisted copy. An unconfigured
   *  CATALOG provider seeds its canonical URL (so the field is filled in, not just
   *  a placeholder); the custom provider seeds whatever is stored, else blank. */
  /* oxlint-disable react/set-state-in-effect -- seeds the form from the fetched backend state */
  useEffect(() => {
    const storedUrl = lockedEndpoint(backendCfg, provider, isCustomProvider(provider))?.baseUrl || ''
    setBaseUrlInput(backendLoading || isCustomProvider(provider) ? storedUrl : (storedUrl || providers.find(p => p.id === provider)?.api || ''))
  }, [backendCfg, provider, backendLoading])
  /** Prefill the model buffer from whatever this provider already has (the store's
   *  current selection for the active provider, else its stored row) so editing an
   *  unconfigured-but-known provider does not demand retyping a model. A live
   *  composer pick wins: it is newer than the fetch this form rendered from, and
   *  the Model field is the same single setting the picker edits. */
  useEffect(() => {
    setModelInput(livePick || providerModel)
  }, [livePick, providerModel])
  /* oxlint-enable react/set-state-in-effect */

  /** The model to validate/persist THIS provider with, in order: the env model
   *  (custom env endpoints), the form's Model field — seeded from a live composer
   *  pick or this provider's stored model, then whatever the user typed — and
   *  this provider's stored row. Never the active provider's model: that belongs
   *  to another provider. The caller discovers one from the endpoint when all
   *  are empty. */
  const effectiveModel = () => resolveProbeModel(provider, modelInputRef.current.trim(), envCustom ? customCfg?.model : undefined)
    || models[provider]
    || ''

  const handleSave = async () => {
    if (!provider || !keyInput || !baseUrlInput.trim()) return
    setSaving(true)
    // A blank field falls back to the catalog default, so a built-in provider can
    // still be saved without the user retyping its canonical URL.
    const p = providers.find(x => x.id === provider)
    const baseUrl = baseUrlInput.trim() || (isCustom ? '' : p?.api || '')
    try {
      /** No model is baked into the catalog, so the key is validated against the
       *  model this form/composer holds, or — for a first-time provider — one
       *  discovered from the endpoint itself. With neither, there is nothing to
       *  validate against: the backend rejects an empty model, so surface the
       *  next step instead of sending a request guaranteed to fail. */
      const probeModel = effectiveModel() || await discoverModel(provider, isCustom ? baseUrl : '', keyInput)
      if (!probeModel) {
        toast.error('Enter a model, or check the Base URL so one can be discovered')
        return
      }
      /** Validate BEFORE persisting: the key must actually work against the
       *  SELECTED provider. Otherwise picking provider A + pasting provider B's
       *  key stores a dead key that fails at ask_ai time. */
      const result = await invoke<string>('test_connection', { provider, model: probeModel, baseUrl, apiKey: keyInput })
      const tools = parseProbeResult(result)
      // test_connection resolved → key is valid for this provider. Persist. The
      // custom path validates any public host; the catalog path allowlists the
      // host AND binds the key to this provider.
      if (isCustom) {
        await invoke('set_custom_endpoint', { provider, baseUrl, key: keyInput, model: probeModel })
      } else {
        await invoke('set_api_key', { provider, baseUrl, key: keyInput, model: probeModel })
      }
      /** Persist measured tool-call support so the badge + transport use it (not
       *  the conservative unmeasured default) — an explicit set_probe, since no
       *  implicit mirror exists any more. ONE toast: the probe outcome is inline
       *  in the save confirmation, not a second toast stacking on top. */
      /** The saved endpoint becomes the source of truth for the locked fields, so
       *  the refresh is what locks them — never an assumption that the write
       *  landed as typed. It also lists the provider as saved, which the probe
       *  record requires. */
      await refreshBackend()
      if (tools !== undefined) await recordToolProbe(provider, probeModel, tools)
      /** A key that just worked clears earlier failed probes, so the next
       *  model this provider runs is measured right away. */
      resetToolProbeBackoff()
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
    } finally {
      /** ALWAYS clears the spin: the early `return`s above (no model to probe
       *  with) skip the rest of `try`, and leaving `saving` true there froze the
       *  Save button on its loader after the error toast had already appeared. */
      setSaving(false)
    }
  }

  const handleTest = async () => {
    if (locked || !provider || !keyInput || !baseUrlInput.trim()) return
    setTesting(true)
    try {
      const p = providers.find(x => x.id === provider)
      const baseUrl = baseUrlInput.trim() || (isCustom ? '' : p?.api || '')
      // Same resolution as save: a model held by this form/composer, else one
      // discovered from the endpoint (a bare Test on a fresh provider must not
      // send an empty model).
      const probeModel = effectiveModel() || await discoverModel(provider, isCustom ? baseUrl : '', keyInput)
      if (!probeModel) {
        toast.error('Enter a model, or check the Base URL so one can be discovered')
        return
      }
      // Test ONLY checks connectivity — it does not measure or persist tool-call
      // support (that's handleSave's probe and the model-switch effect).
      await invoke<string>('test_connection', { provider, model: probeModel, baseUrl, apiKey: keyInput })
      toast.success('Connection OK')
    } catch (e) {
      toast.error(String(e))
    } finally {
      // Same runaway-loader guard as Save: an early return must not strand the
      // Test button spinning after its toast.
      setTesting(false)
    }
  }

  /** Total revoke: the backend drops the bound base URL, the model and the stored
   *  probes along with the key, and the browser cannot recover any of it. */
  const handleRevoke = async () => {
    if (!provider) return
    setConfirmRevoke(false)
    setSaving(true)
    try {
      await invoke('delete_api_key', { provider })
      /** ONE complete removal, not three partial ones: the store drops the key,
       *  the model, the base URL, the probes and the saved-provider row together.
       *  Clearing only the key here left a stale model that the unlocked Model
       *  field then rendered — the outdated model outliving the revoke. */
      forgetProvider(provider)
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

  const revokeDialog = confirmRevoke && (
    <div role="alertdialog" aria-modal="true" aria-label="Revoke provider" className="fixed inset-0 z-220 flex items-center justify-center bg-overlay"
      onClick={cancelRevoke} onKeyDown={e => { if (e.key === 'Escape') cancelRevoke() }}>
      <div className="ui-popover p-4 w-80" onClick={e => e.stopPropagation()}>
        <div className="text-sm font-semibold mb-1">Revoke {selectedProvider?.name ?? provider}?</div>
        <div className="text-xs text-foreground-secondary mb-2 break-all font-mono">{stored?.baseUrl || baseUrlInput || selectedProvider?.api || ''}</div>
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
  )

  return (
    <div data-testid={`provider-form-${provider}`} className={first ? FORM_DIVIDER_FIRST_CLASS : FORM_DIVIDER_CLASS}>
      <h4 className="text-sm font-semibold text-foreground mb-3">{selectedProvider?.name ?? provider}</h4>
      {selectedProvider && (
        <>
          {/* Base URL — EVERY provider owns one (the backend stores it per provider
              and validates it at send time). Unlocked, the field is a typed buffer
              pre-filled with the provider's default URL; locked, it renders the
              FETCHED endpoint so no buffer can drift from what the backend has. */}
          <label className="text-xs font-medium text-foreground mb-1.5 block">Base URL{envCustom && envBadge}</label>
          {locked ? (
            <input type="text" value={stored?.baseUrl || ''} readOnly aria-label="Base URL" style={LOCKED_FIELD}
              className="w-full border border-border rounded-md px-3 py-[7px] text-xs outline-none font-mono mb-3 bg-background text-foreground" />
          ) : (
            <input type="text" value={baseUrlInput} onChange={e => setBaseUrlInput(e.target.value)} aria-label="Base URL"
              placeholder="https://proxy.example.com/v1 — OpenAI-compatible endpoint"
              className="w-full border border-border rounded-md px-3 py-[7px] text-xs outline-none font-mono mb-3 bg-background text-foreground" />
          )}

          {/* Model — UNCONFIGURED only. The composer's picker needs a saved key
              to list models, so this field is the one way to name the model the
              key is validated against; a blank field still works (a model is
              discovered from the endpoint instead). CONFIGURED: hidden, because
              the composer picker owns selection from then on. */}
          {!locked && (
            <>
              <label className="text-xs font-medium text-foreground mb-1.5 block">Model</label>
              <input type="text" value={modelInput} onChange={e => setModelInput(e.target.value)} aria-label="Model"
                placeholder="e.g. gpt-4o-mini — blank discovers one from the endpoint"
                className="w-full bg-background border border-border rounded-md px-3 py-[7px] text-xs text-foreground outline-none font-mono mb-3" />
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
                <button onClick={handleSave} disabled={!keyInput || saving || !baseUrlInput.trim()}
                  className="px-3.5 py-[7px] text-xs rounded-md bg-accent text-on-accent border-none whitespace-nowrap flex items-center gap-1 cursor-pointer disabled:opacity-40 disabled:cursor-default">
                  {saving ? <Loader size={12} className="animate-spin" /> : <Check size={12} />}
                  {saving ? '...' : 'Save'}
                </button>
                <button onClick={handleTest} disabled={!keyInput || testing || !baseUrlInput.trim()}
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
        </>
      )}
      {revokeDialog}
    </div>
  )
}
