// @vitest-environment jsdom

/**
 * SettingsPane — the editor-container settings surface.
 *
 * Each sidebar menu owns ONE page: the pane renders only the selected menu's
 * page, with the section id the sidebar tree links to. Navigation lives in the
 * sidebar, rendering lives here.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { settle } from '../harness'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('../../../frontend/lib/ipc', async importOriginal => ({
  ...await importOriginal<typeof import('../../../frontend/lib/ipc')>(),
  invoke,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import SettingsPane from '../../../frontend/components/SettingsPane'
import { useAiSettings } from '../../../frontend/stores/aiSettings'
import { useSettings } from '../../../frontend/stores/settings'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | null

async function render() {
  root = createRoot(document.getElementById('root')!)
  act(() => root!.render(<SettingsPane />))
  await settle()
}

const section = (id: string) => document.querySelector<HTMLElement>(`[data-settings-section]#${id}`)
const heading = () => document.querySelector<HTMLHeadingElement>('[data-testid="settings-page-heading"]')
/** The Provider section's content, whose anchor id rides the page heading: on the
 *  AI page it is the element that directly follows the heading. */
const providerSection = () => heading()!.nextElementSibling as HTMLElement

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  document.body.dataset.theme = 'dark'
  useAiSettings.setState({
    provider: '', model: '', apiKey: '', savedProviders: [],
    apiKeys: {}, models: {}, baseUrls: {}, probeTools: {},
  })
  useSettings.setState({ open: true, section: 'ai-provider' })
  invoke.mockReset()
  invoke.mockImplementation(async (command: string) => {
    if (command === 'ai_settings') return JSON.stringify({ active: '', endpoints: {}, savedProviders: [] })
    if (command === 'custom_ai_config') return JSON.stringify({ source: 'ui', hasKey: false })
    if (command === 'git_settings') return JSON.stringify({ isRepo: false, noVault: true, name: '', email: '', defaultBranch: 'main', remotes: [] })
    return ''
  })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  vi.clearAllMocks()
})

describe('SettingsPane — surfaces in the editor container', () => {
  it('renders the pane without a modal overlay', async () => {
    await render()

    expect(document.querySelector('[data-testid="settings-container"]')).not.toBeNull()
  })

  it('does not count as a blocking modal when open', async () => {
    await render()

    // No fixed overlay captures pointer events — the workspace stays usable.
    const pane = document.querySelector('[data-testid="settings-container"]')!
    expect(pane.className).not.toContain('fixed')
    expect(pane.className).not.toContain('bg-overlay')
  })
})

describe('SettingsPane — one page per menu', () => {
  /** The pane shows the selected section's PAGE; a section on another page
   *  renders that page instead. */
  it('renders the page that owns the selected section', async () => {
    useSettings.setState({ open: true, section: 'git-identity' })
    await render()

    // The Git page: Identity's anchor rides the page heading, Remotes keeps its
    // own section id. Both sidebar rows resolve to real targets.
    expect(heading()!.id).toBe('git-identity')
    expect(section('git-remotes')).not.toBeNull()
    // No other page is present.
    expect(document.getElementById('general-themes')).toBeNull()
    expect(document.getElementById('ai-provider')).toBeNull()
  })

  /** The AI page's Provider section holds all three provider forms as content
   *  (no per-provider anchors), and Web Tools follows it — the two rows the
   *  sidebar lists. */
  it('renders the AI page with the Provider forms and Web Tools', async () => {
    useSettings.setState({ open: true, section: 'ai-provider' })
    await render()

    for (const id of ['ai-provider', 'ai-web-tools']) {
      expect(document.getElementById(id), `missing AI page anchor ${id}`).not.toBeNull()
    }
    // Three provider forms render INSIDE the Provider section (one per provider).
    const provider = section('ai-web-tools')!.previousElementSibling as HTMLElement
    expect(provider.querySelectorAll('[data-testid^="provider-form-"]')).toHaveLength(3)
    // No nested per-provider anchors.
    expect(provider.querySelectorAll('[data-settings-section]')).toHaveLength(0)
    expect(document.getElementById('git-identity')).toBeNull()
  })

  /** The three forms are separated by their own headings and dividers, so the
   *  user can tell OpenAI Compatible from Opencode Go from Deepseek. */
  it('separates the three provider forms with a heading and divider each', async () => {
    useSettings.setState({ open: true, section: 'ai-provider' })
    await render()

    // Provider's anchor is the page heading, so its content sits on the page body.
    const provider = providerSection()
    const forms = Array.from(provider.querySelectorAll<HTMLElement>('[data-testid^="provider-form-"]'))
    expect(forms.map(form => form.querySelector('h4')!.textContent))
      .toEqual(['OpenAI Compatible', 'Opencode Go', 'DeepSeek'])

    // The TOP card carries the divider-free treatment (it sits right under the
    // section heading), while the two cards below it draw a divider above.
    expect(forms[0].className).not.toContain('border-t')
    for (const form of forms.slice(1)) {
      expect(form.className).toContain('border-t')
      expect(form.className).toContain('border-border-subtle')
    }
    // The forms are NOT wrapped in a `space-y-*` container.
    expect(provider.querySelector('.space-y-6')).toBeNull()
  })

  /** The Provider and Web Tools sections share the ONE AI page, so selecting
   *  either keeps both mounted. */
  it('renders the same AI page for either of its sections', async () => {
    useSettings.setState({ open: true, section: 'ai-web-tools' })
    await render()

    expect(section('ai-web-tools')).not.toBeNull()
    // Provider's anchor is the page heading; its forms are still on the page.
    expect(heading()!.id).toBe('ai-provider')
    expect(providerSection().querySelectorAll('[data-testid^="provider-form-"]')).toHaveLength(3)
  })

  /** Switching between two sections of the SAME page swaps no page — only the
   *  scroll target changes; both sections stay mounted. */
  it('keeps the page while moving between its sections', async () => {
    useSettings.setState({ open: true, section: 'git-identity' })
    await render()

    act(() => useSettings.setState({ section: 'git-remotes' }))
    await settle()

    // Identity (the heading anchor) and Remotes stay on the ONE Git page.
    expect(heading()!.id).toBe('git-identity')
    expect(section('git-remotes')).not.toBeNull()
  })

  /** Moving to a section of ANOTHER page swaps the page. */
  it('swaps the page when the section belongs to another page', async () => {
    useSettings.setState({ open: true, section: 'git-identity' })
    await render()
    expect(heading()!.id).toBe('git-identity')

    act(() => useSettings.setState({ section: 'general-themes' }))
    await settle()

    expect(heading()!.id).toBe('general-themes')
    expect(document.getElementById('git-identity')).toBeNull()
  })

  /** Every provider form is mounted on the AI page, but only the SELECTED
   *  provider's form renders its controls — the others are inert. */
  it('mounts every provider form on the AI page', async () => {
    useSettings.setState({ open: true, section: 'ai-provider' })
    await render()

    expect(document.querySelectorAll('[data-testid^="provider-form-"]')).toHaveLength(3)

    act(() => useSettings.setState({ section: 'ai-web-tools' }))
    await settle()

    // Still mounted after navigating to the other AI section.
    expect(providerSection().querySelectorAll('[data-testid^="provider-form-"]')).toHaveLength(3)
  })

  /** Selecting the Provider section seeds the custom provider only when nothing
   *  is chosen yet; an existing choice is never overridden. */
  it('seeds the custom provider on the Provider section without overriding a choice', async () => {
    useSettings.setState({ open: true, section: 'ai-provider' })
    await render()
    expect(useAiSettings.getState().provider).toBe('openai-compatible')

    act(() => useAiSettings.getState().setProvider('deepseek'))
    act(() => useSettings.setState({ section: 'ai-web-tools' }))
    act(() => useSettings.setState({ section: 'ai-provider' }))
    await settle()
    expect(useAiSettings.getState().provider).toBe('deepseek')
  })

  /** The AI page renders ONE Base URL field PER provider — every provider owns
   *  its endpoint, so all three are editable at once (unlike the old design where
   *  only the selected provider's URL rendered). */
  it('renders a per-provider Base URL field for every provider', async () => {
    useSettings.setState({ open: true, section: 'ai-provider' })
    await render()

    const custom = document.querySelector('[data-testid="provider-form-openai-compatible"]')!
    const go = document.querySelector('[data-testid="provider-form-opencode-go"]')!
    const deepseek = document.querySelector('[data-testid="provider-form-deepseek"]')!

    expect(custom.querySelector('input[aria-label="Base URL"]')).not.toBeNull()
    expect(go.querySelector('input[aria-label="Base URL"]')).not.toBeNull()
    expect(deepseek.querySelector('input[aria-label="Base URL"]')).not.toBeNull()
    expect(document.querySelectorAll('input[aria-label="Base URL"]')).toHaveLength(3)
  })

  /** Every sidebar row resolves to a real, visible anchor: the first section of a
   *  page is its heading, the rest are sections. The id is never duplicated. */
  it('exposes every section as a real anchor', async () => {
    for (const id of ['general-themes', 'git-identity', 'ai-provider', 'ai-web-tools'] as const) {
      if (root) act(() => root!.unmount())
      useSettings.setState({ open: true, section: id })
      await render()

      const anchor = document.getElementById(id)
      expect(anchor, `missing anchor ${id}`).not.toBeNull()
      expect(anchor!.className).not.toContain('sr-only')
      expect(anchor!.className).not.toContain('hidden')
      // One node per id: the first section is the heading, not also a section body.
      expect(document.querySelectorAll(`#${id}`)).toHaveLength(1)
    }
  })

  /** General is the FIRST page: opening Settings with no explicit section lands
   *  on it (the store's default), so its Themes section is the one rendered. */
  it('renders the General page for the default section', async () => {
    useSettings.setState({ open: true, section: 'general-themes' })
    await render()

    expect(heading()!.id).toBe('general-themes')
    expect(document.getElementById('git-identity')).toBeNull()
  })

  /** The page heading IS the page's menu name, so the pane and the sidebar row
   *  that opened it always read the same. */
  it('titles each page with its menu name', async () => {
    for (const [id, title] of [['general-themes', 'General'], ['git-identity', 'Git'], ['ai-provider', 'AI'], ['ai-web-tools', 'AI']] as const) {
      if (root) act(() => root!.unmount())
      useSettings.setState({ open: true, section: id })
      await render()

      expect(heading()!.textContent).toBe(title)
    }
  })

  /** The FIRST section of a page anchors to the page heading itself: the sidebar
   *  row for it scrolls to the heading, and no section body repeats the id. */
  it('anchors the first section to the page heading', async () => {
    for (const [id, title] of [['general-themes', 'General'], ['git-identity', 'Git'], ['ai-provider', 'AI']] as const) {
      if (root) act(() => root!.unmount())
      useSettings.setState({ open: true, section: id })
      await render()

      expect(heading()!.textContent, `heading for ${id}`).toBe(title)
      expect(heading()!.id, `heading anchor for ${id}`).toBe(id)
      // The id is on the heading, not duplicated on a section body.
      expect(document.querySelector(`[data-settings-section]#${id}`)).toBeNull()
    }
  })

  /** Account is a Docker/web-only section: the desktop build has no account or
   *  runtime config, so the pane omits it there (matching the sidebar row).
   *  The harness runs with `isTauri === false`, i.e. the Docker/web server. */
  it('renders the Account section on the web/Docker runtime', async () => {
    useSettings.setState({ open: true, section: 'general-account' })
    await render()

    expect(section('general-account')).not.toBeNull()
    // It lives on the SAME page as Themes (whose anchor is the page heading).
    expect(heading()!.id).toBe('general-themes')
  })

  /** The section at the TOP of a page (Themes on General, Provider on AI) is the
   *  page heading itself, so there is no top border to draw; the section below it
   *  keeps the divider. */
  it('has no top border above the page heading but one below it', async () => {
    useSettings.setState({ open: true, section: 'ai-provider' })
    await render()
    expect(heading()!.className).not.toContain('border-t')
    expect(document.querySelector('[data-settings-section]#ai-provider')).toBeNull()
    expect(section('ai-web-tools')!.className).toContain('border-t')

    if (root) act(() => root!.unmount())
    useSettings.setState({ open: true, section: 'general-themes' })
    await render()
    expect(heading()!.className).not.toContain('border-t')
    expect(section('general-account')!.className).toContain('border-t')
  })
})

describe('SettingsPane — anchor scroll', () => {
  /** A section taller than the window: the user scrolls inside it, then clicks
   *  the SAME sidebar anchor to jump back to its top. The selected section id is
   *  value-equal on the repeat, so without the store's nav nudge the scroll effect
   *  would be skipped and the click would do nothing. */
  it('re-centers the pane when the same section is re-selected', async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll as unknown as typeof Element.prototype.scrollIntoView
    try {
      await render()

      scroll.mockClear()
      // Re-select the section that is already current (the repeat click).
      act(() => useSettings.getState().setSection('ai-provider'))
      await settle()

      expect(scroll).toHaveBeenCalled()
    } finally {
      // jsdom leaves scrollIntoView undefined; the pane guards its call and the
      // other settings tests rely on that no-op, so put it back.
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  /** A LAST section shorter than the pane: `scrollIntoView({block:'start'})`
   *  clamps at the scroll limit, so the section can never reach the top — it
   *  hovers near the bottom with the previous (long) section filling the view.
   *  The pane reserves trailing space so the section top-aligns: the amount is
   *  `clientHeight - lastSectionHeight - 72` (72 = pane py-10 + section
   *  scroll-mt-8). jsdom has no layout, so the geometry is stubbed. */
  it('keeps the pane a containing block so a positioned child cannot escape to the document', async () => {
    useSettings.setState({ open: true, section: 'ai-provider' })
    await render()

    const pane = document.querySelector<HTMLElement>('.settings-pane-scroll')!
    // The reported bug (short window / IME): Mantine's input labels are
    // `.sr-only`, an ABSOLUTELY-positioned element with no positioned ancestor.
    // Its containing block then falls back to the INITIAL containing block, so it
    // escapes this box's `overflow-y: auto` clip and lands at the bottom of the
    // scrolled content — which gives the DOCUMENT scroll range. The anchor
    // effect's `scrollIntoView` (and the IME caret reveal) then scroll the shell,
    // dragging the 48px mobile top bar off the top of the screen. jsdom has no
    // layout, so the invariant is asserted structurally: the scroll box must be
    // positioned to be that containing block.
    expect(pane.classList.contains('relative')).toBe(true)
  })

  it('reserves trailing space so a short LAST section can reach the top', async () => {
    useSettings.setState({ open: true, section: 'ai-web-tools' })
    await render()

    const pane = document.querySelector<HTMLElement>('.settings-pane-scroll')!
    const content = pane.firstElementChild as HTMLElement
    const sections = content.querySelectorAll<HTMLElement>('[data-settings-section]')
    const lastSection = sections[sections.length - 1]
    // The section the sidebar anchors on the AI page IS the last one.
    expect(lastSection.id).toBe('ai-web-tools')

    Object.defineProperty(pane, 'clientHeight', { value: 500, configurable: true })
    Object.defineProperty(lastSection, 'offsetHeight', { value: 300, configurable: true })

    act(() => useSettings.getState().setSection('ai-web-tools'))
    await settle()

    // 500 - 300 - 72 = 128.
    expect(content.style.paddingBottom).toBe('128px')
  })

  /** A last section that already fills (or exceeds) the pane reaches the top on
   *  its own, so no trailing space is reserved — the page keeps its natural
   *  bottom instead of gaining a blank gap. */
  it('reserves no trailing space when the last section already fills the pane', async () => {
    useSettings.setState({ open: true, section: 'ai-web-tools' })
    await render()

    const pane = document.querySelector<HTMLElement>('.settings-pane-scroll')!
    const content = pane.firstElementChild as HTMLElement
    const sections = content.querySelectorAll<HTMLElement>('[data-settings-section]')
    const lastSection = sections[sections.length - 1]

    Object.defineProperty(pane, 'clientHeight', { value: 500, configurable: true })
    Object.defineProperty(lastSection, 'offsetHeight', { value: 1000, configurable: true })

    act(() => useSettings.getState().setSection('ai-web-tools'))
    await settle()

    expect(content.style.paddingBottom).toBe('')
  })
})
