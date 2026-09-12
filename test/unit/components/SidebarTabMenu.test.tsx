// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SidebarTabMenu, { type SidebarPanelId } from '../../../frontend/components/panels/SidebarTabMenu'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | null

function renderMenu(props: { active: SidebarPanelId; onChange: (panel: SidebarPanelId) => void; trashCount: number; isNative: boolean }) {
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
  it('renders four tabs in order', () => {
    renderMenu({ active: 'vault', onChange: vi.fn(), trashCount: 0, isNative: true })

    expect(tabs()).toHaveLength(4)
    expect(tabs().map(tab => tab.getAttribute('aria-label'))).toEqual(['Vault', 'AI Chat', 'History', 'Trash'])
    expect(tabById('sidebar-panel-vault')).not.toBeNull()
    expect(tabById('sidebar-panel-ai')).not.toBeNull()
    expect(tabById('sidebar-panel-git')).not.toBeNull()
    expect(tabById('trash-toggle')).not.toBeNull()
  })

  it('shows the title text only on the active tab', () => {
    const labels: Record<SidebarPanelId, string> = { vault: 'Vault', ai: 'AI Chat', git: 'History', trash: 'Trash' }
    for (const active of ['vault', 'ai', 'git', 'trash'] as SidebarPanelId[]) {
      if (root) act(() => root!.unmount())
      renderMenu({ active, onChange: vi.fn(), trashCount: 5, isNative: true })

      for (const tab of tabs()) {
        const expected = tab.getAttribute('aria-label') === labels[active] ? labels[active] : ''
        expect(tab.textContent).toBe(expected)
      }
    }
  })

  it('does not render a trash count indicator', () => {
    renderMenu({ active: 'vault', onChange: vi.fn(), trashCount: 7, isNative: true })

    const menu = document.querySelector('[role="tablist"]')!
    expect(menu.textContent).not.toMatch(/[0-9]/)
    expect(tabById('trash-toggle').textContent).toBe('')
  })

  it('disables web trash only when the trash count is zero', () => {
    renderMenu({ active: 'vault', onChange: vi.fn(), trashCount: 0, isNative: false })
    expect(tabById('trash-toggle').disabled).toBe(true)

    act(() => root!.unmount())
    renderMenu({ active: 'vault', onChange: vi.fn(), trashCount: 3, isNative: false })
    expect(tabById('trash-toggle').disabled).toBe(false)

    for (const id of ['sidebar-panel-vault', 'sidebar-panel-ai', 'sidebar-panel-git']) {
      expect(tabById(id).disabled).toBe(false)
    }
  })

  it('keeps native trash enabled even when empty', () => {
    renderMenu({ active: 'vault', onChange: vi.fn(), trashCount: 0, isNative: true })

    expect(tabById('trash-toggle').disabled).toBe(false)
  })

  it('reports the selected panel through onChange', () => {
    const onChange = vi.fn()
    renderMenu({ active: 'vault', onChange, trashCount: 2, isNative: true })

    act(() => tabById('sidebar-panel-ai').click())
    expect(onChange).toHaveBeenLastCalledWith('ai')

    act(() => tabById('sidebar-panel-git').click())
    expect(onChange).toHaveBeenLastCalledWith('git')

    act(() => tabById('trash-toggle').click())
    expect(onChange).toHaveBeenLastCalledWith('trash')

    act(() => tabById('sidebar-panel-vault').click())
    expect(onChange).toHaveBeenLastCalledWith('vault')
    expect(onChange).toHaveBeenCalledTimes(4)
  })

  it('ignores clicks on disabled web trash', () => {
    const onChange = vi.fn()
    renderMenu({ active: 'vault', onChange, trashCount: 0, isNative: false })

    act(() => tabById('trash-toggle').click())
    expect(onChange).not.toHaveBeenCalled()
  })
})
