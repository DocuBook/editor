// @vitest-environment jsdom
/**
 * WebToolsSettings — the AI page's Web Tools section. The backend is the source
 * of truth: the pane renders what `web_tools_settings` returned, sends changes
 * through the dedicated commands, and never reads the Tavily key back.
 */
import { act } from 'react'
import { MantineProvider } from '@mantine/core'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settle } from '../harness'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }))
vi.mock('../../../frontend/lib/ipc', async importOriginal => ({
  ...await importOriginal<typeof import('../../../frontend/lib/ipc')>(),
  invoke,
}))
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }))
import WebToolsSettings from '../../../frontend/components/settings/WebToolsSettings'

/** Backend state the mocked commands read and write. */
let backend: { settings: Record<string, unknown>; hasTavilyKey: boolean; envManaged: boolean }
let root: Root | null = null
let host: HTMLDivElement

beforeEach(() => {
  // Mantine reads the color scheme and sizes and scrolls its popover; jsdom has none of these APIs.
  window.matchMedia ??= (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null }) as MediaQueryList
  Element.prototype.scrollIntoView ??= () => {}
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
  backend = { settings: { searchProvider: 'off', searxngUrl: '', fetchEnabled: false, maxResults: 5 }, hasTavilyKey: false, envManaged: false }
  invoke.mockReset()
  invoke.mockImplementation(async (command: string, args: any) => {
    if (command === 'web_tools_settings') return JSON.stringify({ ...backend, maxResultsLimit: 10 })
    if (command === 'set_web_tools_settings') { backend.settings = args.settings; return null }
    if (command === 'set_web_search_key') { backend.hasTavilyKey = true; return null }
    if (command === 'delete_web_search_key') { backend.hasTavilyKey = false; return null }
    throw new Error(`unexpected ${command}`)
  })
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host.remove()
})

async function render() {
  root = createRoot(host)
  act(() => root!.render(<MantineProvider><WebToolsSettings /></MantineProvider>))
  await settle()
}

const select = () => host.querySelector<HTMLInputElement>('#web-search-provider')!

/** Open Mantine's Select and pick a row — its dropdown portals to <body>. */
async function pick(label: string) {
  act(() => select().click())
  await settle()
  const option = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(node => node.textContent === label)!
  act(() => option.click())
  await settle()
}
const button = (text: string) => Array.from(host.querySelectorAll('button')).find(node => node.textContent === text)

/** Fire React's change handler for a controlled input or select. */
function change(element: HTMLInputElement | HTMLSelectElement, value: string | boolean) {
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  const field = typeof value === 'boolean' ? 'checked' : 'value'
  Object.getOwnPropertyDescriptor(proto, field)!.set!.call(element, value)
  act(() => { element.dispatchEvent(new Event(typeof value === 'boolean' ? 'click' : 'change', { bubbles: true })) })
}

describe('WebToolsSettings', () => {
  it('starts off and saves only after a change', async () => {
    await render()
    expect(host.textContent).toContain('Off — the AI cannot reach the web')
    expect(button('Save')!.disabled).toBe(true)

    await pick('SearXNG (self-hosted)')
    change(host.querySelector<HTMLInputElement>('#web-searxng-url')!, 'http://searxng:8080')
    act(() => button('Save')!.click())
    await settle()

    expect(invoke).toHaveBeenCalledWith('set_web_tools_settings', { settings: { searchProvider: 'searxng', searxngUrl: 'http://searxng:8080', fetchEnabled: false, maxResults: 5 } })
    expect(host.textContent).toContain('Enabled: SearXNG search')
    expect(toastSuccess).toHaveBeenCalledWith('Web tool settings saved')
  })

  it('saves the result count and the page-reading toggle, and rejects a count out of range', async () => {
    backend.settings = { ...backend.settings, searchProvider: 'searxng', searxngUrl: 'http://searxng:8080' }
    await render()
    const count = host.querySelector<HTMLInputElement>('#web-max-results')!
    change(count, '25')
    expect(button('Save')!.disabled).toBe(true)
    change(count, '')
    expect(button('Save')!.disabled).toBe(true)

    change(count, '8')
    act(() => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    expect(button('Save')!.disabled).toBe(false)
    act(() => button('Save')!.click())
    await settle()

    expect(invoke).toHaveBeenCalledWith('set_web_tools_settings', { settings: { searchProvider: 'searxng', searxngUrl: 'http://searxng:8080', fetchEnabled: true, maxResults: 8 } })
  })

  it('stores the Tavily key through its own command and never shows it again', async () => {
    backend.settings = { ...backend.settings, searchProvider: 'tavily' }
    await render()
    expect(host.textContent).toContain('Tavily search (key missing)')
    expect(host.textContent).toContain('use queries to improve its service')

    change(host.querySelector<HTMLInputElement>('#web-search-key')!, 'tvly-secret')
    act(() => button('Save key')!.click())
    await settle()

    expect(invoke).toHaveBeenCalledWith('set_web_search_key', { key: 'tvly-secret' })
    expect(host.querySelector('#web-search-key')).toBeNull()
    expect(host.textContent).toContain('API key saved')
    expect(host.innerHTML).not.toContain('tvly-secret')
  })

  it('keeps an unsaved provider choice while the key is saved', async () => {
    await render()
    await pick('Tavily (API key)')
    change(host.querySelector<HTMLInputElement>('#web-search-key')!, 'tvly-secret')
    act(() => button('Save key')!.click())
    await settle()

    // The key is stored, the draft still says Tavily, and Save is waiting for the user.
    expect(backend.hasTavilyKey).toBe(true)
    expect(select().value).toBe('Tavily (API key)')
    expect(host.textContent).toContain('API key saved')
    expect(button('Save')!.disabled).toBe(false)
    expect(invoke).not.toHaveBeenCalledWith('set_web_tools_settings', expect.anything())

    act(() => button('Save')!.click())
    await settle()
    expect(backend.settings).toMatchObject({ searchProvider: 'tavily' })
    expect(host.textContent).toContain('Enabled: Tavily search')
  })

  it('locks the provider when the environment manages it', async () => {
    backend = { ...backend, envManaged: true, hasTavilyKey: true, settings: { ...backend.settings, searchProvider: 'tavily' } }
    await render()
    expect(select().disabled).toBe(true)
    expect(button('Remove key')).toBeUndefined()
    expect(host.textContent).toContain('DOCUBOOK_SEARXNG_URL')
  })

  it('shows a retryable error when the settings cannot be loaded', async () => {
    invoke.mockImplementationOnce(async () => { throw new Error('offline') })
    await render()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('offline')
    act(() => button('Retry')!.click())
    await settle()
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(select()).not.toBeNull()
  })
})
