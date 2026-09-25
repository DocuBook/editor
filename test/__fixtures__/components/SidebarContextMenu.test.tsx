// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { flush, tick } from '../harness'

import SidebarContextMenu from '../../../frontend/components/SidebarContextMenu'

let root: Root | null
/** A tree row, as `visibleItems` hands it over. */
const item = { path: 'notes/active.md', name: 'active.md', type: '0', depth: 0 }

const menu = () => document.querySelector<HTMLElement>('[data-ctx-menu]')!
const menuButton = (label: string) =>
  Array.from(menu().querySelectorAll<HTMLButtonElement>('button')).find(node => node.textContent === label)!

function renderMenu() {
  const props = {
    item,
    position: { x: 12, y: 34 },
    onClose: vi.fn(),
    onCreate: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
  }
  root = createRoot(document.getElementById('root')!)
  act(() => root!.render(<SidebarContextMenu {...props} />))
  return props
}

beforeEach(() => { document.body.innerHTML = '<div id="root"></div>' })
afterEach(() => { if (root) act(() => root!.unmount()); root = null; vi.clearAllMocks() })

describe('SidebarContextMenu', () => {
  /** Portaled like every pointer-anchored surface: the mobile drawer's transform
   *  would otherwise make the drawer the containing block of a `fixed` menu and
   *  confine it to the drawer box. */
  it('renders its actions anchored at the pointer, outside the sidebar', async () => {
    renderMenu()
    await flush()

    expect(menu().closest('#root')).toBeNull()
    expect(menu().style.top).toBe('34px')
    expect(menu().style.left).toBe('12px')
    expect(Array.from(menu().querySelectorAll('button')).map(node => node.textContent))
      .toEqual(['New File', 'New Folder', 'Rename', 'Delete'])
  })

  it('hands every action the row it was opened on', async () => {
    const props = renderMenu()
    await flush()

    act(() => menuButton('New File').click())
    act(() => menuButton('New Folder').click())
    act(() => menuButton('Rename').click())
    act(() => menuButton('Delete').click())

    expect(props.onCreate).toHaveBeenNthCalledWith(1, 'file', item)
    expect(props.onCreate).toHaveBeenNthCalledWith(2, 'folder', item)
    expect(props.onRename).toHaveBeenCalledWith(item)
    expect(props.onDelete).toHaveBeenCalledWith(item)
  })

  /** The menu dismisses itself, so the caller's actions never have to close it
   *  and no stale menu can outlive the action it just started. */
  it('dismisses itself before running the picked action', async () => {
    const props = renderMenu()
    await flush()

    act(() => menuButton('New File').click())

    expect(props.onClose.mock.invocationCallOrder[0]).toBeLessThan(props.onCreate.mock.invocationCallOrder[0])
  })

  it('closes on a click outside', async () => {
    const props = renderMenu()
    await flush()

    act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))

    expect(props.onClose).toHaveBeenCalled()
  })

  /** The portal's trap claims `[data-autofocus]`, and the menu puts that on itself
   *  — left to the trap's fallback it would claim the first tabbable control,
   *  pre-seating "New File" for whatever Enter comes next. */
  it('focuses the menu itself rather than its first action', async () => {
    renderMenu()
    await flush()
    await tick()

    expect(document.activeElement).toBe(menu())
    expect(document.activeElement).not.toBe(menuButton('New File'))
  })

  it('walks the rows with the arrow keys, wrapping at both ends', async () => {
    renderMenu()
    await flush()
    await tick()

    /** Dispatched on the menu, which is where focus sits until an arrow is pressed. */
    const press = (key: string) => act(() => menu().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))

    press('ArrowDown')
    expect(document.activeElement).toBe(menuButton('New File'))

    press('ArrowDown')
    expect(document.activeElement).toBe(menuButton('New Folder'))

    press('ArrowUp')
    expect(document.activeElement).toBe(menuButton('New File'))

    press('ArrowUp')
    expect(document.activeElement).toBe(menuButton('Delete'))

    press('Home')
    expect(document.activeElement).toBe(menuButton('New File'))

    press('End')
    expect(document.activeElement).toBe(menuButton('Delete'))
  })

  it('closes on Escape', async () => {
    const props = renderMenu()
    await flush()

    act(() => menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))

    expect(props.onClose).toHaveBeenCalled()
  })
})
