// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import TrashPanel, { type TrashItem } from '../../../frontend/components/panels/TrashPanel'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | null

const fileItem: TrashItem = { name: 'file-1.md', original: 'notes/file-1.md', deleted_at: Date.parse('2026-01-02T00:00:00Z'), is_dir: false }
const folderItem: TrashItem = { name: 'folder-1', original: 'notes/folder-1', deleted_at: Date.parse('2026-02-03T00:00:00Z'), is_dir: true }

function renderPanel(overrides: Partial<{ items: TrashItem[]; loading: boolean; error: string; onRestore: (item: TrashItem) => void; onDelete: (item: TrashItem) => void; onEmpty: () => void; onBack: () => void }> = {}) {
  const props = {
    items: [] as TrashItem[],
    loading: false,
    error: '',
    onRestore: vi.fn(),
    onDelete: vi.fn(),
    onEmpty: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  }
  root = createRoot(document.getElementById('root')!)
  act(() => root!.render(<TrashPanel {...props} />))
  return props
}

const byLabel = (label: string) => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
const byText = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === text)!

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  vi.clearAllMocks()
})

describe('TrashPanel', () => {
  it('shows a loading state while the first page loads', () => {
    renderPanel({ loading: true, items: [] })

    expect(document.body.textContent).toContain('Trash (0)')
    expect(document.body.textContent).toContain('Loading Trash...')
    expect(document.body.textContent).not.toContain('Trash is empty')
    expect(byText('Empty Trash')).toBeUndefined()
  })

  it('shows an empty state when there are no items', () => {
    renderPanel({ loading: false, items: [] })

    expect(document.body.textContent).toContain('Trash is empty')
    expect(document.body.textContent).not.toContain('Loading Trash...')
    expect(byText('Empty Trash')).toBeUndefined()
  })

  it('surfaces an error message', () => {
    renderPanel({ error: 'Could not load trash' })

    expect(document.querySelector('[role="alert"]')!.textContent).toBe('Could not load trash')
  })

  it('lists files and folders with restore and delete controls', () => {
    renderPanel({ items: [fileItem, folderItem] })

    expect(document.body.textContent).toContain('Trash (2)')
    expect(document.body.textContent).toContain('notes/file-1.md')
    expect(document.body.textContent).toContain('notes/folder-1')

    const fileRow = byLabel('Put back notes/file-1.md')!.parentElement!
    const folderRow = byLabel('Put back notes/folder-1')!.parentElement!
    expect(fileRow.querySelector('svg.lucide-file')).not.toBeNull()
    expect(fileRow.querySelector('svg.lucide-folder')).toBeNull()
    expect(folderRow.querySelector('svg.lucide-folder')).not.toBeNull()
    expect(folderRow.querySelector('svg.lucide-file')).toBeNull()

    expect(byLabel('Delete notes/file-1.md permanently')).not.toBeNull()
    expect(byLabel('Delete notes/folder-1 permanently')).not.toBeNull()
    expect(byText('Empty Trash')).not.toBeUndefined()
  })

  it('invokes callbacks for restore, delete, empty and back', () => {
    const props = renderPanel({ items: [fileItem, folderItem] })

    act(() => byLabel('Put back notes/file-1.md')!.click())
    expect(props.onRestore).toHaveBeenCalledWith(fileItem)

    act(() => byLabel('Delete notes/folder-1 permanently')!.click())
    expect(props.onDelete).toHaveBeenCalledWith(folderItem)

    act(() => byText('Empty Trash').click())
    expect(props.onEmpty).toHaveBeenCalledTimes(1)

    act(() => byText('Back').click())
    expect(props.onBack).toHaveBeenCalledTimes(1)
  })
})
