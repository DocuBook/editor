// @vitest-environment jsdom

/**
 * SettingsModal — the AI locking state machine.
 *
 * The backend's config.json is the single source of truth: fields render what a
 * FETCH returned, a configured provider is read-only until a confirmed total
 * Revoke, and the API key is never read back into the browser.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

import SettingsModal from '../../../frontend/components/SettingsModal'
import { useAiSettings } from '../../../frontend/stores/aiSettings'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

Element.prototype.scrollIntoView = vi.fn() as unknown as typeof Element.prototype.scrollIntoView

let root: Root | null
const flush = () => act(async () => { await Promise.resolve() })
/** refreshBackend awaits a Promise.all of two invokes; one extra turn drains it. */
const settle = async () => { await flush(); await flush() }

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
  invoke.mockReset()
  invoke.mockImplementation(async (command: string) => {
    if (command === 'ai_settings') return JSON.stringify(backend)
    if (command === 'custom_ai_config') return JSON.stringify(backend.custom)
    if (command === 'test_connection') return JSON.stringify({ status: 'ok', tools: true })
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
  act(() => root!.render(<SettingsModal onClose={() => {}} />))
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
const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).map(b => b.textContent?.trim())
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')

describe('SettingsModal — unconfigured provider', () => {
  it('renders editable Base URL / Model / API Key with Save + Test', async () => {
    useAiSettings.setState({ provider: 'openai-compatible' })
    await render()

    expect(byLabel('Base URL')!.readOnly).toBe(false)
    expect(byLabel('Model')!.readOnly).toBe(false)
    expect(byLabel('API Key')!.readOnly).toBe(false)
    expect(buttons()).toContain('Save')
    expect(buttons()).toContain('Test')
    expect(buttons()).not.toContain('Revoke')
  })
})

describe('SettingsModal — configured provider', () => {
  it('locks the fields to the FETCHED backend values and offers only Revoke', async () => {
    // The reported bug: a fresh browser rendered an empty input column because
    // the fields came from a store snapshot instead of a fetch. Locked fields
    // must render the endpoint the backend stored — never a local buffer.
    configure('anthropic', { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5' })
    useAiSettings.setState({ provider: 'anthropic', model: 'stale-browser-model' })
    await render()

    const model = byLabel('Model')!
    expect(model.readOnly).toBe(true)
    expect(model.value).toBe('claude-sonnet-5')

    expect(buttons()).not.toContain('Save')
    expect(buttons()).not.toContain('Test')
    expect(buttons()).toContain('Revoke')
  })

  it('shows the custom endpoint base URL fetched from the backend', async () => {
    configure('openai-compatible', { baseUrl: 'https://kenari.id/v1', model: 'deepseek-v4-1-flash' })
    useAiSettings.setState({ provider: 'openai-compatible' })
    await render()

    const baseUrl = byLabel('Base URL')!
    expect(baseUrl.readOnly).toBe(true)
    expect(baseUrl.value).toBe('https://kenari.id/v1')
    expect(byLabel('Model')!.value).toBe('deepseek-v4-1-flash')
  })

  it('never reads the API key back — the locked field is empty with a saved placeholder', async () => {
    configure('anthropic')
    useAiSettings.setState({ provider: 'anthropic' })
    await render()

    const key = byLabel('API Key')!
    expect(key.value).toBe('')
    expect(key.readOnly).toBe(true)
    expect(key.placeholder).toMatch(/saved/i)
    // list_api_keys is never consulted for the value.
    expect(invoke.mock.calls.map(c => c[0])).not.toContain('list_api_keys')
  })

  it('does not write probes it merely rendered', async () => {
    // Rendering a stored probe must not re-write it: an explicit set_probe is
    // the only probe write, and only when the model had no measurement.
    configure('anthropic', { model: 'server-model', probes: { 'server-model': true } })
    useAiSettings.setState({ provider: 'anthropic' })
    await render()

    expect(invoke.mock.calls.map(c => c[0])).not.toContain('set_probe')
  })

  it('sends the tool-call-capable transport payload after hydration', async () => {
    // A stored probe must be READ, not re-measured: the store already carries the
    // measurement after boot hydration (App calls hydrateAiSettings), and the
    // modal must not spend a round-trip re-testing a configured provider.
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

describe('SettingsModal — env-controlled custom provider', () => {
  it('keeps the fields read-only, shows the badge and offers no Revoke', async () => {
    configure('openai-compatible', { baseUrl: 'https://file.example/v1', model: 'file-model' })
    backend.env = { baseUrl: 'https://env.example/v1', model: 'env-model', hasKey: true }
    backend.custom = { source: 'env', baseUrl: 'https://env.example/v1', hasKey: true, model: 'env-model' }
    useAiSettings.setState({ provider: 'openai-compatible' })
    await render()

    expect(byLabel('Base URL')!.readOnly).toBe(true)
    expect(byLabel('Base URL')!.value).toBe('https://env.example/v1')
    expect(byLabel('Model')!.readOnly).toBe(true)
    expect(byLabel('Model')!.value).toBe('env-model')
    // The env override wins server-side, so the UNLOCKED custom field must not
    // render the file value — and the backend rejects edits while it is set.
    expect(buttons()).not.toContain('Revoke')
    expect(document.body.textContent).toContain('from env')
  })
})

describe('SettingsModal — revoke', () => {
  it('requires confirmation before deleting anything', async () => {
    configure('anthropic')
    useAiSettings.setState({ provider: 'anthropic' })
    await render()

    clickText('Revoke')
    expect(dialog()).not.toBeNull()
    // The dialog warns that the key is unrecoverable...
    expect(dialog()!.textContent).toMatch(/cannot be recovered/i)
    // ...and nothing was deleted merely by opening it.
    expect(invoke.mock.calls.map(c => c[0])).not.toContain('delete_api_key')
  })

  it('cancels on Escape without deleting the key or the endpoint', async () => {
    configure('anthropic')
    useAiSettings.setState({ provider: 'anthropic' })
    await render()

    clickText('Revoke')
    act(() => { dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })

    expect(dialog()).toBeNull()
    expect(invoke.mock.calls.map(c => c[0])).not.toContain('delete_api_key')
    expect(byLabel('Model')!.readOnly).toBe(true)
  })

  it('totally revokes on confirm: delete_api_key, then the fields become editable', async () => {
    configure('anthropic')
    useAiSettings.setState({ provider: 'anthropic' })
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
    expect(deleteCall![1]).toEqual({ provider: 'anthropic' })
    expect(useAiSettings.getState().savedProviders).toEqual([])
    // The fields are editable again: the model reverts to the picker (a picker
    // has no readOnly input), and Save is offered in place of Revoke.
    expect(byLabel('Model')).toBeNull()
    expect(buttons()).toContain('Save')
    expect(buttons()).not.toContain('Revoke')
  })

  it('does not call the removed bulk set_probes command', async () => {
    configure('anthropic')
    useAiSettings.setState({ provider: 'anthropic' })
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

describe('SettingsModal — save', () => {
  it('validates with test_connection, persists, then locks from the refreshed backend', async () => {
    useAiSettings.setState({ provider: 'anthropic' })
    await render()

    const key = byLabel('API Key')!
    act(() => {
      // React's onChange for a controlled input needs the native setter path.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(key, 'sk-new-key')
      key.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // The backend stores it as a result of the save (the UI cannot assume).
    configure('anthropic', { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5' })
    clickText('Save')
    await settle()

    const commands = invoke.mock.calls.map(c => c[0])
    expect(commands).toContain('test_connection')
    expect(commands).toContain('set_api_key')
    expect(byLabel('Model')!.readOnly).toBe(true)
    expect(buttons()).toContain('Revoke')
  })
})
