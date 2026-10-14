// @vitest-environment jsdom

/**
 * SettingsPane — the AI locking state machine.
 *
 * The backend's config.json is the single source of truth: fields render what a
 * FETCH returned, a configured provider is read-only until a confirmed total
 * Revoke, and the API key is never read back into the browser.
 *
 * The AI form is one of the pane's sections (on the AI page). These tests select
 * that page through the store, exactly as the sidebar tree does.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { settle } from '../harness'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }))

/** Backend state the mocked commands read from — mutated by tests to model what
 *  a save/revoke did server-side. The UI must follow it, never lead it. */
const backend = {
  active: '',
  endpoints: {} as Record<string, unknown>,
  savedProviders: [] as string[],
  env: undefined as undefined | { baseUrl: string; model: string; hasKey: boolean },
  custom: { source: 'file', baseUrl: '', hasKey: false, model: '' } as Record<string, unknown>,
}

vi.mock('../../../frontend/lib/ipc', async importOriginal => ({
  ...await importOriginal<typeof import('../../../frontend/lib/ipc')>(),
  invoke,
}))
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }))

import SettingsPane from '../../../frontend/components/SettingsPane'
import { useAiSettings } from '../../../frontend/stores/aiSettings'
import { useSettings } from '../../../frontend/stores/settings'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

Element.prototype.scrollIntoView = vi.fn() as unknown as typeof Element.prototype.scrollIntoView

let root: Root | null

/** A configured provider, as the backend would report it. */
function configure(provider: string, over: Partial<{ baseUrl: string; model: string; probes: Record<string, boolean> }> = {}) {
  backend.active = provider
  backend.savedProviders = [provider]
  backend.endpoints = {
    [provider]: {
      baseUrl: over.baseUrl ?? 'https://api.example.com/v1',
      model: over.model ?? 'server-model',
      probes: over.probes ?? { 'server-model': true },
      hasKey: true,
    },
  }
}

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  backend.active = ''
  backend.endpoints = {}
  backend.savedProviders = []
  backend.env = undefined
  backend.custom = { source: 'file', baseUrl: '', hasKey: false, model: '' }
  useAiSettings.setState({
    provider: '', model: '', apiKey: '', savedProviders: [],
    apiKeys: {}, models: {}, baseUrls: {}, probeTools: {},
  })
  useSettings.setState({ open: true, section: 'ai-provider' })
  invoke.mockReset()
  invoke.mockImplementation(async (command: string) => {
    if (command === 'ai_settings') return JSON.stringify(backend)
    if (command === 'custom_ai_config') return JSON.stringify(backend.custom)
    if (command === 'mcp_settings') return JSON.stringify({ servers: [], envManaged: false })
    if (command === 'test_connection') return JSON.stringify({ status: 'ok', tools: true })
    // Model discovery is the ONLY source of a model (no catalog default), so a
    // first-time save/test discovers one from the endpoint.
    if (command === 'list_models') return JSON.stringify([{ id: 'discovered-model', name: 'Discovered' }])
    return ''
  })
  toastSuccess.mockReset()
  toastError.mockReset()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
})

async function render() {
  root = createRoot(document.getElementById('root')!)
  act(() => root!.render(<SettingsPane />))
  await settle()
}

/** Click the first element whose trimmed text is exactly `text`. */
function clickText(text: string) {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('button, div, span'))
    .filter(node => node.textContent?.trim() === text)
  const target = nodes[0]
  if (!target) throw new Error(`no element with text "${text}"`)
  act(() => target.click())
}

/** Click the confirm button INSIDE the revoke dialog. The confirm button shares its
 *  label with the trigger that opened the dialog, so text alone is ambiguous; the
 *  dialog is the element with role=alertdialog, and only its own button acts. */
function clickConfirmRevoke() {
  const confirm = document.querySelector<HTMLButtonElement>('[role="alertdialog"] button.bg-danger')
  if (!confirm) throw new Error('no confirm button in the revoke dialog')
  act(() => confirm.click())
}

const byLabel = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
/** Scope a query to the form for `provider`. Three provider forms render on the
 *  AI page, so a bare `input[aria-label="Base URL"]` matches all of them; the
 *  form's own test id pins the one under test. */
const sectionOf = (provider: string) => document.querySelector<HTMLElement>(`[data-testid="provider-form-${provider}"]`)!
const inSection = (provider: string, label: string) => sectionOf(provider).querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
const buttonsIn = (provider: string) => Array.from(sectionOf(provider).querySelectorAll<HTMLButtonElement>('button')).map(b => b.textContent?.trim())
const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).map(b => b.textContent?.trim())
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')
/** The buttons swap their label/icon for a `Loader` while busy (Test keeps an
 *  sr-only label, so loading state is read from the spinner class instead). */
const testing = (button: HTMLButtonElement) => !!button.querySelector('.animate-spin')

describe('SettingsPane — unconfigured provider', () => {
  it('renders an editable Base URL, Model and API Key with Save + Test', async () => {
    useAiSettings.setState({ provider: 'openai-compatible' })
    await render()

    // Base URL is editable for EVERY provider (the backend stores it per provider).
    expect(byLabel('Base URL')!.readOnly).toBe(false)
    expect(byLabel('API Key')!.readOnly).toBe(false)
    expect(buttons()).toContain('Save')
    expect(buttons()).toContain('Test')
    expect(buttons()).not.toContain('Revoke')
  })

  /** The composer's picker needs a SAVED key before it can list models, so while
   *  the provider is unconfigured this form is the only place to name a model —
   *  otherwise the user is stuck (no key without a model, no model without a key). */
  it('offers a Model field while the provider is unconfigured', async () => {
    useAiSettings.setState({ provider: 'openai-compatible' })
    await render()

    const model = inSection('openai-compatible', 'Model')!
    expect(model.readOnly).toBe(false)
    expect(model.value).toBe('')
    // Leaving it blank is allowed: a model is then discovered from the endpoint.
    expect(model.placeholder).toMatch(/discover/i)
  })

  /** Once configured, the Model field disappears: the composer picker owns
   *  selection, so Settings stops being a second model UI. */
  it('hides the Model field once the provider is configured', async () => {
    configure('opencode-go', { model: 'server-model' })
    useAiSettings.setState({ provider: 'opencode-go' })
    await render()

    expect(inSection('opencode-go', 'Model')).toBeNull()
  })

  it('pre-fills a catalog provider base URL with its default, editable value', async () => {
    useAiSettings.setState({ provider: 'deepseek' })
    await render()

    const url = inSection('deepseek', 'Base URL')!
    expect(url.readOnly).toBe(false)
    // The field is FILLED IN with the catalog default, not just a placeholder.
    expect(url.value).toBe('https://api.deepseek.com')
  })

  /** A rejection shows a toast AND clears the button: the failure path used to
   *  `return` past the reset, leaving Save/Test spinning forever. */
  it('clears the Save and Test spinners when the connection is rejected', async () => {
    useAiSettings.setState({ provider: 'openai-compatible' })
    await render()

    const setValue = (input: HTMLInputElement, value: string) => act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    setValue(inSection('openai-compatible', 'Model')!, 'typed-model')
    setValue(inSection('openai-compatible', 'API Key')!, 'sk-bad-key')
    setValue(inSection('openai-compatible', 'Base URL')!, 'https://kenari.id/v1')

    invoke.mockImplementation(async (command: string) => {
      if (command === 'ai_settings') return JSON.stringify(backend)
      if (command === 'custom_ai_config') return JSON.stringify(backend.custom)
      if (command === 'test_connection') throw new Error('401 Unauthorized')
      return ''
    })

    const save = sectionOf('openai-compatible').querySelector<HTMLButtonElement>('button.px-3\\.5')!
    const test = sectionOf('openai-compatible').querySelector<HTMLButtonElement>('button[aria-label="Check connection"]')!

    act(() => test.click())
    await settle()
    expect(testing(test), 'Test still spinning after a rejected connection').toBe(false)

    act(() => save.click())
    await settle()
    expect(testing(save), 'Save still spinning after a rejected connection').toBe(false)
    // Neither path persisted anything on failure.
    expect(invoke.mock.calls.map(c => c[0])).not.toContain('set_custom_endpoint')
  })
})

describe('SettingsPane — configured provider', () => {
  it('locks the fields to the FETCHED backend values and offers only Revoke', async () => {
    // The reported bug: a fresh browser rendered an empty input column because
    // the fields came from a store snapshot instead of a fetch. Locked fields
    // must render the endpoint the backend stored — never a local buffer.
    configure('opencode-go', { baseUrl: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4-flash' })
    useAiSettings.setState({ provider: 'opencode-go', model: 'stale-browser-model' })
    await render()

    const baseUrl = inSection('opencode-go', 'Base URL')!
    expect(baseUrl.readOnly).toBe(true)
    expect(baseUrl.value).toBe('https://opencode.ai/zen/go/v1')
    // No Model field in Settings at all.
    expect(inSection('opencode-go', 'Model')).toBeNull()

    expect(buttonsIn('opencode-go')).not.toContain('Save')
    expect(buttonsIn('opencode-go')).not.toContain('Test')
    expect(buttonsIn('opencode-go')).toContain('Revoke')
  })

  it('shows the custom endpoint base URL fetched from the backend', async () => {
    configure('openai-compatible', { baseUrl: 'https://kenari.id/v1', model: 'deepseek-v4-1-flash' })
    useAiSettings.setState({ provider: 'openai-compatible' })
    await render()

    const baseUrl = byLabel('Base URL')!
    expect(baseUrl.readOnly).toBe(true)
    expect(baseUrl.value).toBe('https://kenari.id/v1')
  })

  it('never reads the API key back — the locked field is empty with a saved placeholder', async () => {
    configure('opencode-go')
    useAiSettings.setState({ provider: 'opencode-go' })
    await render()

    const key = inSection('opencode-go', 'API Key')!
    expect(key.value).toBe('')
    expect(key.readOnly).toBe(true)
    expect(key.placeholder).toMatch(/saved/i)
    // list_api_keys is never consulted for the value.
    expect(invoke.mock.calls.map(c => c[0])).not.toContain('list_api_keys')
  })

  it('sends the same base URL to test_connection and set_api_key for a catalog provider', async () => {
    useAiSettings.setState({ provider: 'deepseek' })
    await render()

    const url = inSection('deepseek', 'Base URL')!
    const key = inSection('deepseek', 'API Key')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(url, 'https://api.deepseek.com/v1')
      url.dispatchEvent(new Event('input', { bubbles: true }))
      setter.call(key, 'sk-new-key')
      key.dispatchEvent(new Event('input', { bubbles: true }))
    })

    act(() => sectionOf('deepseek').querySelector<HTMLButtonElement>('button.px-3\\.5')!.click())
    await settle()

    // Every provider owns a base URL: the typed value is validated AND persisted
    // (no separate catalog-hardcoded URL on the save path any more).
    const test = invoke.mock.calls.find(c => c[0] === 'test_connection')
    expect(test![1]).toMatchObject({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' })
    const save = invoke.mock.calls.find(c => c[0] === 'set_api_key')
    expect(save![1]).toMatchObject({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' })
  })

  it('does not write probes it merely rendered', async () => {
    // Rendering a stored probe must not re-write it: an explicit set_probe is
    // the only probe write, and only when the model had no measurement.
    configure('opencode-go', { model: 'server-model', probes: { 'server-model': true } })
    useAiSettings.setState({ provider: 'opencode-go' })
    await render()

    expect(invoke.mock.calls.map(c => c[0])).not.toContain('set_probe')
  })

  it('sends the tool-call-capable transport payload after hydration', async () => {
    // A stored probe must be READ, not re-measured: the store already carries the
    // measurement after boot hydration (App calls hydrateAiSettings), and the
    // pane must not spend a round-trip re-testing a configured provider.
    configure('opencode-go', { model: 'deepseek-v4-flash', probes: { 'deepseek-v4-flash': true } })
    useAiSettings.setState({
      provider: 'opencode-go',
      models: { 'opencode-go': 'deepseek-v4-flash' },
      probeTools: { 'opencode-go': { 'deepseek-v4-flash': true } },
    })
    await render()

    expect(invoke.mock.calls.map(c => c[0])).not.toContain('test_connection')
    expect(invoke.mock.calls.map(c => c[0])).not.toContain('set_probe')
  })
})

describe('SettingsPane — env-controlled custom provider', () => {
  it('keeps the fields read-only, shows the badge and offers no Revoke', async () => {
    configure('openai-compatible', { baseUrl: 'https://file.example/v1', model: 'file-model' })
    backend.env = { baseUrl: 'https://env.example/v1', model: 'env-model', hasKey: true }
    backend.custom = { source: 'env', baseUrl: 'https://env.example/v1', hasKey: true, model: 'env-model' }
    useAiSettings.setState({ provider: 'openai-compatible' })
    await render()

    expect(byLabel('Base URL')!.readOnly).toBe(true)
    expect(byLabel('Base URL')!.value).toBe('https://env.example/v1')
    // No Model field anywhere: the model is the composer's concern. The env badge
    // still marks the field the backend actually uses.
    expect(byLabel('Model')).toBeNull()
    // The env override wins server-side, so the UNLOCKED custom field must not
    // render the file value — and the backend rejects edits while it is set.
    expect(buttons()).not.toContain('Revoke')
    expect(document.body.textContent).toContain('from env')
  })
})

describe('SettingsPane — revoke', () => {
  it('requires confirmation before deleting anything', async () => {
    configure('opencode-go')
    useAiSettings.setState({ provider: 'opencode-go' })
    await render()

    clickText('Revoke')
    expect(dialog()).not.toBeNull()
    // The dialog warns that the key is unrecoverable...
    expect(dialog()!.textContent).toMatch(/cannot be recovered/i)
    // ...and nothing was deleted merely by opening it.
    expect(invoke.mock.calls.map(c => c[0])).not.toContain('delete_api_key')
  })

  it('cancels on Escape without deleting the key or the endpoint', async () => {
    configure('opencode-go')
    useAiSettings.setState({ provider: 'opencode-go' })
    await render()

    clickText('Revoke')
    act(() => { dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })

    expect(dialog()).toBeNull()
    expect(invoke.mock.calls.map(c => c[0])).not.toContain('delete_api_key')
    expect(inSection('opencode-go', 'Base URL')!.readOnly).toBe(true)
  })

  it('totally revokes on confirm: delete_api_key, then the fields become editable', async () => {
    configure('opencode-go')
    useAiSettings.setState({ provider: 'opencode-go' })
    await render()

    clickText('Revoke')
    // The backend is the source of truth for what happens next: drop the key and
    // every endpoint value, exactly as a total revoke does.
    backend.active = ''
    backend.endpoints = {}
    backend.savedProviders = []
    clickConfirmRevoke()
    await settle()

    const deleteCall = invoke.mock.calls.find(c => c[0] === 'delete_api_key')
    expect(deleteCall).toBeDefined()
    expect(deleteCall![1]).toEqual({ provider: 'opencode-go' })
    expect(useAiSettings.getState().savedProviders).toEqual([])
    // The fields are editable again (with the catalog default pre-filled) and Save
    // is offered in place of Revoke.
    expect(inSection('opencode-go', 'Base URL')!.readOnly).toBe(false)
    expect(buttonsIn('opencode-go')).toContain('Save')
    expect(buttonsIn('opencode-go')).not.toContain('Revoke')
  })

  it('does not call the removed bulk set_probes command', async () => {
    configure('opencode-go')
    useAiSettings.setState({ provider: 'opencode-go' })
    await render()

    clickText('Revoke')
    backend.active = ''
    backend.endpoints = {}
    backend.savedProviders = []
    clickConfirmRevoke()
    await settle()

    expect(invoke.mock.calls.map(c => c[0])).not.toContain('set_probes')
  })
})

describe('SettingsPane — save', () => {
  it('validates with test_connection, persists, then locks from the refreshed backend', async () => {
    useAiSettings.setState({ provider: 'opencode-go' })
    await render()

    const key = inSection('opencode-go', 'API Key')!
    const url = inSection('opencode-go', 'Base URL')!
    act(() => {
      // React's onChange for a controlled input needs the native setter path.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(key, 'sk-new-key')
      key.dispatchEvent(new Event('input', { bubbles: true }))
      setter.call(url, 'https://opencode.ai/zen/go/v1')
      url.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // The backend stores it as a result of the save (the UI cannot assume).
    configure('opencode-go', { baseUrl: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4-flash' })
    // Three provider sections render on the AI page, so target the Save
    // button inside the opencode-go section rather than a page-wide lookup.
    act(() => sectionOf('opencode-go').querySelector<HTMLButtonElement>('button.px-3\\.5')!.click())
    await settle()

    const commands = invoke.mock.calls.map(c => c[0])
    expect(commands).toContain('test_connection')
    expect(commands).toContain('set_api_key')
    expect(inSection('opencode-go', 'Base URL')!.readOnly).toBe(true)
    expect(buttonsIn('opencode-go')).toContain('Revoke')
  })

  /** No model is baked into the catalog, so a first-time save (no model picked
   *  yet) must DISCOVER one from the endpoint rather than send an empty model the
   *  backend rejects. */
  it('discovers a model before the first save instead of sending an empty one', async () => {
    useAiSettings.setState({ provider: 'opencode-go', model: '', models: {} })
    await render()

    const key = inSection('opencode-go', 'API Key')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(key, 'sk-new-key')
      key.dispatchEvent(new Event('input', { bubbles: true }))
    })

    configure('opencode-go', { model: 'discovered-model' })
    act(() => sectionOf('opencode-go').querySelector<HTMLButtonElement>('button.px-3\\.5')!.click())
    await settle()

    // list_models seeded the model, and the SAME id is what got validated + saved.
    expect(invoke.mock.calls.map(c => c[0])).toContain('list_models')
    expect(invoke.mock.calls.find(c => c[0] === 'test_connection')![1]).toMatchObject({ model: 'discovered-model' })
    expect(invoke.mock.calls.find(c => c[0] === 'set_api_key')![1]).toMatchObject({ model: 'discovered-model' })
  })

  /** A model typed into the form is what the key is validated against — no
   *  round-trip to the composer's picker, which cannot list models before a key
   *  is saved. */
  it('validates and saves with the model typed into the form', async () => {
    useAiSettings.setState({ provider: 'openai-compatible', model: '', models: {} })
    await render()

    const setValue = (input: HTMLInputElement, value: string) => act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    setValue(inSection('openai-compatible', 'Model')!, 'typed-model')
    setValue(inSection('openai-compatible', 'API Key')!, 'sk-new-key')
    setValue(inSection('openai-compatible', 'Base URL')!, 'https://kenari.id/v1')

    configure('openai-compatible', { baseUrl: 'https://kenari.id/v1', model: 'typed-model' })
    act(() => sectionOf('openai-compatible').querySelector<HTMLButtonElement>('button.px-3\\.5')!.click())
    await settle()

    expect(invoke.mock.calls.find(c => c[0] === 'test_connection')![1]).toMatchObject({ model: 'typed-model' })
    expect(invoke.mock.calls.find(c => c[0] === 'set_custom_endpoint')![1]).toMatchObject({ model: 'typed-model' })
  })
})

describe('SettingsPane — MCP settings loading', () => {
  it('blocks changes after a failed load until retry succeeds', async () => {
    useSettings.setState({ open: true, section: 'ai-mcp-server' })
    invoke.mockImplementation(async (command: string) => {
      if (command === 'mcp_settings') throw new Error('offline')
      if (command === 'ai_settings') return JSON.stringify(backend)
      if (command === 'custom_ai_config') return JSON.stringify(backend.custom)
      return ''
    })
    await render()

    expect(document.querySelector('[role="alert"]')?.textContent).toContain('offline')
    expect(document.querySelector<HTMLInputElement>('input[placeholder="docs"]')?.disabled).toBe(true)
    expect(Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Add remote')?.disabled).toBe(true)
    expect(invoke.mock.calls.map(call => call[0])).not.toContain('config_set')

    invoke.mockImplementation(async (command: string) => {
      if (command === 'mcp_settings') return JSON.stringify({ servers: [], envManaged: false })
      if (command === 'ai_settings') return JSON.stringify(backend)
      if (command === 'custom_ai_config') return JSON.stringify(backend.custom)
      return ''
    })
    clickText('Retry')
    await settle()

    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.querySelector<HTMLInputElement>('input[placeholder="docs"]')?.disabled).toBe(false)
    expect(Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Add remote')?.disabled).toBe(true)
    expect(document.body.textContent).toContain('Server Name')
    expect(document.body.textContent).toContain('default 10')
    expect(document.body.textContent).toContain('Authorization: Bearer')
    expect(document.body.textContent).not.toContain('Read-only tool names')
  })

  it('saves a named remote with a timeout override without a manual tool list', async () => {
    useSettings.setState({ open: true, section: 'ai-mcp-server' })
    let configuredServers: Array<Record<string, unknown>> = []
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'mcp_settings') return JSON.stringify({
        servers: configuredServers,
        envManaged: false,
        defaultTimeoutSeconds: 10,
        maxTimeoutSeconds: 120,
      })
      if (command === 'ai_settings') return JSON.stringify(backend)
      if (command === 'custom_ai_config') return JSON.stringify(backend.custom)
      if (command === 'config_set') {
        configuredServers = (args?.value as Array<Record<string, unknown>>) ?? []
        return ''
      }
      return ''
    })
    await render()

    const setValue = (input: HTMLInputElement, value: string) => act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    setValue(document.querySelector<HTMLInputElement>('input[placeholder="docs"]')!, 'research')
    setValue(document.querySelector<HTMLInputElement>('input[placeholder="https://mcp.example.com/mcp"]')!, 'https://mcp.example.com/mcp')
    setValue(document.querySelector<HTMLInputElement>('input[type="number"]')!, '25')
    clickText('Add remote')
    await settle()

    const saved = invoke.mock.calls.find(call => call[0] === 'config_set')?.[1]?.value as Array<Record<string, unknown>>
    expect(saved[0]).toMatchObject({ name: 'research', url: 'https://mcp.example.com/mcp', timeoutSeconds: 25 })
    expect(saved[0]).not.toHaveProperty('readOnlyTools')
  })
})
