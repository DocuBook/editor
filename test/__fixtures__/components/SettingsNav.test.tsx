// @vitest-environment jsdom

/**
 * SettingsNav — the sidebar settings tree.
 *
 * One menu shape: every menu (General, Git, AI) expands straight to its page's
 * section anchors and opens its OWN page. The AI menu's page has three sections:
 * Provider (whose content is the three provider forms) and Web Tools. The tree
 * is the ONLY navigation surface for the editor-container settings pane, so its
 * ids must match the pane's section ids.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SettingsNav from '../../../frontend/components/settings/SettingsNav'
import { useSettings } from '../../../frontend/stores/settings'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | null

function render() {
  root = createRoot(document.getElementById('root')!)
  act(() => root!.render(<SettingsNav />))
}

const group = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="settings-nav-group-${id}"]`)
const anchor = (id: string) => document.querySelector<HTMLAnchorElement>(`[data-testid="settings-nav-section-${id}"]`)

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  useSettings.setState({ open: false, section: 'general-themes' })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  vi.clearAllMocks()
})

describe('SettingsNav — structure', () => {
  /** Only the menu owning the selected section is expanded; the others are
   *  collapsed, so the tree shows one page's sections at a time. */
  it('renders only the selected menu expanded', () => {
    render()

    expect(group('general')!.getAttribute('aria-expanded')).toBe('true')
    expect(group('git')!.getAttribute('aria-expanded')).toBe('false')
    expect(group('ai')!.getAttribute('aria-expanded')).toBe('false')
  })

  it('expands the menu that owns the selected section', () => {
    useSettings.setState({ section: 'ai-web-tools' })
    render()

    expect(group('ai')!.getAttribute('aria-expanded')).toBe('true')
    expect(group('general')!.getAttribute('aria-expanded')).toBe('false')
  })

  it('lists every leaf anchor the settings pane exposes', () => {
    render()

    // Expand each menu in turn to reach its leaves: opening one menu collapses
    // the others, so each iteration re-expands the owner before reading.
    const ids = [
      'general-themes',
      'general-account',
      'git-identity',
      'git-remotes',
      'ai-provider',
      'ai-web-tools',
    ]
    const owners: Record<string, string> = {
      'general-themes': 'general', 'general-account': 'general',
      'git-identity': 'git', 'git-remotes': 'git',
      'ai-provider': 'ai', 'ai-web-tools': 'ai',
    }
    let open = 'general'
    for (const id of ids) {
      const owner = owners[id]!
      // Opening the owner collapses the previously expanded menu, so the row is
      // only visible right after its own menu is the expanded one.
      if (owner !== open) {
        act(() => group(owner)!.click())
        open = owner
      }
      expect(anchor(id), `missing anchor ${id}`).not.toBeNull()
      expect(anchor(id)!.getAttribute('href')).toBe(`#${id}`)
    }
  })

  /** Provider is ONE row whose content holds the three forms: the forms are not
   *  sidebar rows of their own. */
  it('lists the AI page sections, Provider then Web Tools', () => {
    useSettings.setState({ section: 'ai-provider' })
    render()

    expect(anchor('ai-provider')!.textContent).toContain('Provider')
    expect(anchor('ai-web-tools')!.textContent).toContain('Web Tools')

    const ai = group('ai')!.parentElement!
    const rows = Array.from(ai.querySelectorAll<HTMLElement>('[data-testid^="settings-nav-section-ai-"]'))
      .map(node => node.getAttribute('data-testid'))
    expect(rows).toEqual(['settings-nav-section-ai-provider', 'settings-nav-section-ai-web-tools'])
  })

  it('marks the active section as current', () => {
    useSettings.setState({ section: 'git-remotes' })
    render()

    expect(anchor('git-remotes')!.getAttribute('aria-current')).toBe('true')
    expect(anchor('git-identity')!.getAttribute('aria-current')).toBeNull()
  })
})

describe('SettingsNav — collapse/expand', () => {
  it('hides a menu’s anchors when collapsed and restores them when expanded', () => {
    render()
    expect(anchor('general-themes')).not.toBeNull()

    act(() => group('general')!.click())
    expect(group('general')!.getAttribute('aria-expanded')).toBe('false')
    expect(anchor('general-themes')).toBeNull()

    act(() => group('general')!.click())
    expect(anchor('general-themes')).not.toBeNull()
  })

  /** Opening a menu collapses every other one: the sidebar never shows two
   *  pages' section lists at the same time. */
  it('collapses every other menu when one is expanded', () => {
    render()

    act(() => group('git')!.click())

    expect(group('git')!.getAttribute('aria-expanded')).toBe('true')
    expect(anchor('git-identity')).not.toBeNull()
    expect(group('general')!.getAttribute('aria-expanded')).toBe('false')
    expect(anchor('general-themes')).toBeNull()
    expect(group('ai')!.getAttribute('aria-expanded')).toBe('false')
    expect(anchor('ai-provider')).toBeNull()
  })

  it('collapses the AI menu to hide all of its sections', () => {
    useSettings.setState({ section: 'ai-provider' })
    render()

    act(() => group('ai')!.click())

    expect(anchor('ai-provider')).toBeNull()
    expect(anchor('ai-web-tools')).toBeNull()
    expect(group('ai')!.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('SettingsNav — a row opens its page and expands', () => {
  /** One click on a menu row opens its page (its first section) AND expands it,
   *  collapsing every other menu. */
  it('opens a menu page while expanding its section list', () => {
    render()
    expect(useSettings.getState().open).toBe(false)

    act(() => group('git')!.click())

    expect(useSettings.getState().open).toBe(true)
    expect(useSettings.getState().section).toBe('git-identity')
    // Opening a menu expands it and collapses the others.
    expect(group('git')!.getAttribute('aria-expanded')).toBe('true')
    expect(group('general')!.getAttribute('aria-expanded')).toBe('false')
  })

  /** The AI menu opens its page at its FIRST section (the Provider forms). */
  it('opens the AI page at its first section', () => {
    render()

    act(() => group('ai')!.click())

    expect(useSettings.getState().open).toBe(true)
    expect(useSettings.getState().section).toBe('ai-provider')
  })

  /** The menu owning the open page reads as active. */
  it('marks the menu that owns the active section', () => {
    useSettings.setState({ section: 'git-remotes' })
    render()

    expect(group('git')!.getAttribute('aria-current')).toBe('true')
    expect(group('ai')!.getAttribute('aria-current')).toBeNull()
  })

  it('marks the AI menu active for its provider and web tools sections alike', () => {
    useSettings.setState({ section: 'ai-provider' })
    render()
    expect(group('ai')!.getAttribute('aria-current')).toBe('true')

    act(() => useSettings.setState({ section: 'ai-web-tools' }))
    expect(group('ai')!.getAttribute('aria-current')).toBe('true')
  })
})

describe('SettingsNav — anchors drive the store', () => {
  it('opens the surface at the clicked section', () => {
    useSettings.setState({ section: 'ai-provider' })
    render()
    expect(useSettings.getState().open).toBe(false)

    act(() => anchor('ai-web-tools')!.click())

    expect(useSettings.getState().open).toBe(true)
    expect(useSettings.getState().section).toBe('ai-web-tools')
  })

  it('keeps the anchor navigation in-app instead of a native fragment jump', () => {
    render()
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    act(() => { anchor('general-themes')!.dispatchEvent(event) })

    // preventDefault was called, so the href never becomes a real navigation.
    expect(event.defaultPrevented).toBe(true)
  })

  /** Account is a Docker/web-only section: on the web/Docker runtime it is
   *  reachable under its menu and anchors to its own section id. */
  it('exposes the Docker-only Account section under General', () => {
    render()
    const account = anchor('general-account')
    expect(account).not.toBeNull()
    expect(account!.getAttribute('href')).toBe('#general-account')

    act(() => account!.click())
    expect(useSettings.getState().section).toBe('general-account')
  })
})
