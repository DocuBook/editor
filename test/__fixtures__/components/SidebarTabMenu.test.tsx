// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SidebarTabMenu, { type SidebarPanelId } from '../../../frontend/components/panels/SidebarTabMenu'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | null

function renderMenu(props: { active: SidebarPanelId; onChange: (panel: SidebarPanelId) => void; disabled?: boolean }) {
  root = createRoot(document.getElementById('root')!)
  act(() => root!.render(<SidebarTabMenu {...props} />))
}

const tabById = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!
const tabs = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'))

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  vi.clearAllMocks()
})

describe('SidebarTabMenu', () => {
  it('renders three tabs in order', () => {
    renderMenu({ active: 'vault', onChange: vi.fn() })

    expect(tabs()).toHaveLength(3)
    expect(tabs().map(tab => tab.getAttribute('aria-label'))).toEqual(['Folders', 'Changes', 'Trash'])
    expect(tabById('sidebar-panel-vault')).not.toBeNull()
    expect(tabById('sidebar-panel-git')).not.toBeNull()
    expect(tabById('trash-toggle')).not.toBeNull()
  })

  it('shows the title text only on the active tab', () => {
    const labels: Record<SidebarPanelId, string> = { vault: 'Folders', git: 'Changes', trash: 'Trash' }
    for (const active of ['vault', 'git', 'trash'] as SidebarPanelId[]) {
      if (root) act(() => root!.unmount())
      renderMenu({ active, onChange: vi.fn() })

      for (const tab of tabs()) {
        const expected = tab.getAttribute('aria-label') === labels[active] ? labels[active] : ''
        expect(tab.textContent).toBe(expected)
      }
    }
  })

  /** Layout contract jsdom cannot measure: the active tab must be sized by its
   *  content so its label is never ellipsized (the old `flex-1 min-w-0 truncate`
   *  combination shrank it to `Chan…`), while icon-only tabs take the slack and
   *  keep a 40px tap floor instead of the old 28px squares. */
  it('sizes the active label to its content and keeps icon tabs tappable', () => {
    const labels: Record<SidebarPanelId, string> = { vault: 'Folders', git: 'Changes', trash: 'Trash' }
    for (const active of ['vault', 'git', 'trash'] as SidebarPanelId[]) {
      if (root) act(() => root!.unmount())
      renderMenu({ active, onChange: vi.fn() })

      for (const tab of tabs()) {
        const classes = tab.className.split(/\s+/)
        const label = tab.querySelector('span.font-medium')
        if (tab.getAttribute('aria-label') === labels[active]) {
          expect(classes).toContain('shrink-0')
          expect(classes).toContain('whitespace-nowrap')
          expect(classes).not.toContain('flex-1')
          expect(classes).not.toContain('min-w-0')
          expect(label).not.toBeNull()
          expect(label!.className).not.toContain('truncate')
          expect(label!.className).not.toContain('min-w-0')
        } else {
          expect(classes).toContain('flex-1')
          expect(classes).toContain('min-w-10')
          expect(classes).not.toContain('shrink-0')
          expect(label).toBeNull()
        }
      }
    }
  })

  it('does not render a trash count indicator', () => {
    renderMenu({ active: 'vault', onChange: vi.fn() })

    const menu = document.querySelector('[role="tablist"]')!
    expect(menu.textContent).not.toMatch(/[0-9]/)
    expect(tabById('trash-toggle').textContent).toBe('')
  })

  /** Trash is reachable on EVERY runtime, empty or not: it used to be gated on
   *  `trashCount > 0` for web only, which made the Docker build lose the panel
   *  entirely until something had been deleted — and lost the "empty" state too.
   *  The panel itself reports emptiness; the tab never hides it. */
  it('keeps every tab enabled regardless of platform or trash contents', () => {
    renderMenu({ active: 'vault', onChange: vi.fn() })

    for (const id of ['sidebar-panel-vault', 'sidebar-panel-git', 'trash-toggle']) {
      expect(tabById(id).disabled).toBe(false)
    }
  })

  it('reports the selected panel through onChange', () => {
    const onChange = vi.fn()
    renderMenu({ active: 'vault', onChange })

    act(() => tabById('sidebar-panel-git').click())
    expect(onChange).toHaveBeenLastCalledWith('git')

    act(() => tabById('trash-toggle').click())
    expect(onChange).toHaveBeenLastCalledWith('trash')

    act(() => tabById('sidebar-panel-vault').click())
    expect(onChange).toHaveBeenLastCalledWith('vault')
    expect(onChange).toHaveBeenCalledTimes(3)
  })

  it('locks every tab while a trash batch action is in flight', () => {
    const onChange = vi.fn()
    renderMenu({ active: 'trash', onChange, disabled: true })

    for (const tab of tabs()) expect(tab.disabled).toBe(true)
    act(() => tabById('sidebar-panel-vault').click())
    expect(onChange).not.toHaveBeenCalled()
  })
})
