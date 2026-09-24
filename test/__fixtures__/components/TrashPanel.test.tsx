// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import TrashPanel, { type TrashItem } from '../../../frontend/components/panels/TrashPanel'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | null
const fileItem: TrashItem = { name: 'file-1.md', original: 'notes/file-1.md', deleted_at: Date.parse('2026-01-02T00:00:00Z'), is_dir: false }
const folderItem: TrashItem = { name: 'folder-1', original: 'notes/folder-1', deleted_at: Date.parse('2026-02-03T00:00:00Z'), is_dir: true }
type Props = { items: TrashItem[]; loading: boolean; error: string; busy: boolean; onRestore: (items: TrashItem[]) => Promise<boolean>; onDelete: (items: TrashItem[]) => Promise<boolean>; onBusyChange: (busy: boolean) => void }

function renderPanel(overrides: Partial<Props> = {}) {
  const props: Props = {
    items: [],
    loading: false,
    error: '',
    busy: false,
    onRestore: vi.fn().mockResolvedValue(true),
    onDelete: vi.fn().mockResolvedValue(true),
    onBusyChange: vi.fn(),
    ...overrides,
  }
  root = createRoot(document.getElementById('root')!)
  act(() => root!.render(<TrashPanel {...props} />))
  return props
}
const textButton = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === text)!
const checkbox = (name: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')
const dialogButton = (text: string) => Array.from(dialog()!.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === text)!

beforeEach(() => { document.body.innerHTML = '<div id="root"></div>' })
afterEach(() => { if (root) act(() => root!.unmount()); root = null; vi.clearAllMocks() })

describe('TrashPanel', () => {
  it('shows states without Back or an inline confirmation dialog', () => {
    renderPanel({ error: 'Could not load trash' })
    expect(document.body.textContent).toContain('Trash is empty')
    expect(document.querySelector('[role="alert"]')!.textContent).toBe('Could not load trash')
    expect(textButton('Delete').disabled).toBe(true)
    expect(textButton('Back')).toBeUndefined()
    expect(dialog()).toBeNull()
  })

  it('runs Put back immediately for selected items', async () => {
    const props = renderPanel({ items: [fileItem, folderItem] })
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(3)
    expect(textButton('Put back').disabled).toBe(true)

    act(() => checkbox('Select notes/file-1.md').click())
    await act(async () => textButton('Put back').click())

    expect(props.onRestore).toHaveBeenCalledWith([fileItem])
    expect(checkbox('Select notes/file-1.md').checked).toBe(false)
  })

  it('opens an in-app confirmation dialog naming the selected items', () => {
    renderPanel({ items: [fileItem, folderItem] })
    act(() => checkbox('Select all trash items').click())
    act(() => textButton('Delete').click())

    expect(dialog()).not.toBeNull()
    expect(dialog()!.textContent).toContain('Delete 2 selected items permanently?')
    expect(dialogButton('Cancel')).not.toBeUndefined()
    expect(dialogButton('Delete')).not.toBeUndefined()
  })

  /** The mobile sidebar drawer transforms its content, which would make the
   *  drawer the containing block of a `fixed` in-tree dialog and clip it down to
   *  the drawer — so the confirmation is portaled to document.body instead. */
  it('renders the confirmation outside the panel so the mobile drawer cannot clip it', () => {
    renderPanel({ items: [fileItem] })
    act(() => checkbox('Select notes/file-1.md').click())
    act(() => textButton('Delete').click())

    expect(dialog()!.parentElement).toBe(document.body)
  })

  it('names a single item in the confirmation', () => {
    renderPanel({ items: [fileItem, folderItem] })
    act(() => checkbox('Select notes/file-1.md').click())
    act(() => textButton('Delete').click())

    expect(dialog()!.textContent).toContain('notes/file-1.md')
  })

  it('deletes the selected items only after the dialog is confirmed', async () => {
    const props = renderPanel({ items: [fileItem, folderItem] })
    act(() => checkbox('Select all trash items').click())
    act(() => textButton('Delete').click())
    expect(props.onDelete).not.toHaveBeenCalled()

    await act(async () => dialogButton('Delete').click())

    expect(props.onDelete).toHaveBeenCalledWith([fileItem, folderItem])
    expect(dialog()).toBeNull()
    expect(checkbox('Select all trash items').checked).toBe(false)
  })

  it('keeps the selection when the confirmation is cancelled', async () => {
    const props = renderPanel({ items: [fileItem] })
    act(() => checkbox('Select notes/file-1.md').click())
    act(() => textButton('Delete').click())
    await act(async () => dialogButton('Cancel').click())

    expect(props.onDelete).not.toHaveBeenCalled()
    expect(dialog()).toBeNull()
    expect(checkbox('Select notes/file-1.md').checked).toBe(true)
  })

  it('keeps the selection when the action reports failures', async () => {
    const props = renderPanel({ items: [fileItem], onDelete: vi.fn().mockResolvedValue(false) })
    act(() => checkbox('Select notes/file-1.md').click())
    act(() => textButton('Delete').click())
    await act(async () => dialogButton('Delete').click())

    expect(props.onDelete).toHaveBeenCalledWith([fileItem])
    expect(props.onBusyChange).toHaveBeenCalledWith(true)
    expect(props.onBusyChange).toHaveBeenCalledWith(false)
    expect(checkbox('Select notes/file-1.md').checked).toBe(true)
  })

  it('locks controls while a batch action runs', async () => {
    let finish!: (value: boolean) => void
    const pending = new Promise<boolean>(resolve => { finish = resolve })
    const onDelete = vi.fn(() => pending)
    const props = renderPanel({ items: [fileItem], onDelete })
    act(() => checkbox('Select notes/file-1.md').click())
    act(() => textButton('Delete').click())
    act(() => { void dialogButton('Delete').click() })

    // The panel reports the in-flight batch; the parent feeds it back as `busy`.
    expect(props.onBusyChange).toHaveBeenCalledWith(true)
    act(() => root!.render(<TrashPanel {...props} busy={true} />))
    expect(textButton('Delete').disabled).toBe(true)
    expect(textButton('Put back').disabled).toBe(true)
    expect(checkbox('Select notes/file-1.md').disabled).toBe(true)

    await act(async () => finish(true))
    expect(onDelete).toHaveBeenCalledWith([fileItem])
    expect(props.onBusyChange).toHaveBeenCalledWith(false)
    expect(checkbox('Select notes/file-1.md').checked).toBe(false)
  })

  it('stays locked while the parent reports a batch already in flight', () => {
    renderPanel({ items: [fileItem], busy: true })
    act(() => checkbox('Select notes/file-1.md').click())

    expect(textButton('Delete').disabled).toBe(true)
    expect(textButton('Put back').disabled).toBe(true)
  })

  it('does not start a second batch when the parent reports one in flight', () => {
    const onDelete = vi.fn().mockResolvedValue(true)
    renderPanel({ items: [fileItem], busy: true, onDelete })
    act(() => checkbox('Select notes/file-1.md').click())
    act(() => textButton('Delete').click())

    expect(dialog()).toBeNull()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('ignores actions while nothing is selected', async () => {
    const props = renderPanel({ items: [fileItem] })
    await act(async () => textButton('Put back').click())
    act(() => textButton('Delete').click())

    expect(props.onRestore).not.toHaveBeenCalled()
    expect(props.onDelete).not.toHaveBeenCalled()
    expect(dialog()).toBeNull()
    expect(checkbox('Select notes/file-1.md').checked).toBe(false)
  })
})
