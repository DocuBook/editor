// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
const aiState = vi.hoisted(() => ({
  provider: null as string | null,
  model: '',
  savedProviders: [] as string[],
  baseUrls: {} as Record<string, string>,
  probeTools: {} as Record<string, Record<string, boolean>>,
}))

vi.mock('../../../frontend/lib/ipc', async importOriginal => ({
  ...await importOriginal<typeof import('../../../frontend/lib/ipc')>(),
  invoke,
}))
vi.mock('../../../frontend/utils/modelDiscovery', async importOriginal => ({
  ...await importOriginal<typeof import('../../../frontend/utils/modelDiscovery')>(),
  fetchProviderModels: vi.fn(async () => []),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../frontend/stores/aiSettings', async importOriginal => {
  const actions = {
    setProvider: vi.fn(), setModel: vi.fn(), clearApiKey: vi.fn(),
    addSavedProvider: vi.fn(), removeSavedProvider: vi.fn(), setProbeTools: vi.fn(),
  }
  const state = () => ({ ...aiState, ...actions })
  const useAiSettings = Object.assign(() => state(), { getState: state })
  return { ...await importOriginal<typeof import('../../../frontend/stores/aiSettings')>(), useAiSettings }
})

import SettingsModal from '../../../frontend/components/SettingsModal'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/** jsdom has no layout, so the scroll-into-view effect would throw. */
Element.prototype.scrollIntoView = vi.fn() as unknown as typeof Element.prototype.scrollIntoView

let root: Root | null

const flush = () => act(async () => { await Promise.resolve() })

function render() {
  root = createRoot(document.getElementById('root')!)
  act(() => root!.render(<SettingsModal onClose={() => {}} />))
}

const dialog = () => document.querySelector<HTMLElement>('[data-testid="settings-modal"]')!
const clickable = (text: string) => {
  const matches = Array.from(document.querySelectorAll<HTMLElement>('*')).filter(node => node.textContent?.trim() === text)
  return matches[matches.length - 1]!
}

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  aiState.provider = null
  aiState.model = ''
  document.body.dataset.theme = 'dark'
  invoke.mockReset()
  invoke.mockImplementation(async (command: string) => {
    if (command === 'custom_ai_config') return JSON.stringify({ source: 'ui', hasKey: false })
    if (command === 'list_api_keys') return JSON.stringify([])
    return JSON.stringify({ tools: true })
  })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
})

/** Regression: .ui-dialog sets backdrop-filter, which makes it the containing
 *  block for position:fixed descendants. Coordinates from getBoundingClientRect
 *  are viewport-relative, so an in-tree dropdown rendered below its field.
 *  Portaling to document.body keeps the menu in the viewport's containing block. */
describe('SettingsModal — dropdown placement', () => {
  it('renders the provider menu outside the blurring dialog, anchored to the viewport', async () => {
    render()
    await flush()

    act(() => clickable('— Select a provider —').click())

    const search = document.querySelector<HTMLInputElement>('input[placeholder="Search providers..."]')
    expect(search).not.toBeNull()
    expect(document.body.contains(search)).toBe(true)
    expect(dialog().contains(search)).toBe(false)
    expect((search!.closest('.ui-popover') as HTMLElement).style.position).toBe('fixed')
  })

  it('renders the model menu outside the blurring dialog too', async () => {
    aiState.provider = 'anthropic'
    render()
    await flush()

    act(() => clickable('— Select a model —').click())

    const search = document.querySelector<HTMLInputElement>('input[placeholder="Search models..."]')
    expect(search).not.toBeNull()
    expect(document.body.contains(search)).toBe(true)
    expect(dialog().contains(search)).toBe(false)
    expect((search!.closest('.ui-popover') as HTMLElement).style.position).toBe('fixed')
  })

  it('keeps the menu open while interacting with it, closing only on an outside click', async () => {
    render()
    await flush()

    act(() => clickable('— Select a provider —').click())
    const search = document.querySelector<HTMLInputElement>('input[placeholder="Search providers..."]')!
    act(() => search.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(document.querySelector('input[placeholder="Search providers..."]')).not.toBeNull()

    act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(document.querySelector('input[placeholder="Search providers..."]')).toBeNull()
  })
})
