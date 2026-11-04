// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { settle } from '../harness'

const invokeMock = vi.fn()
vi.mock('../../../frontend/lib/ipc', () => ({
  invoke: (...args: any[]) => invokeMock(...args),
}))

import InlineProperties from '../../../frontend/components/editor/InlineProperties'
import { useEditorStore } from '../../../frontend/stores/editor'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/** Shaped like the backend reply: `name` is the file stem, without `.md`. */
const BACKLINKS = [
  { path: 'Daily/2026-11-03.md', name: '2026-11-03', snippet: 'update [[Roadmap]] hari ini' },
  { path: 'Ideas.md', name: 'Ideas', snippet: '' },
]

let root: Root | null = null
let container: HTMLDivElement
const openFile = vi.fn()

async function render(path = 'Roadmap.md') {
  await act(async () => { root!.render(<MantineProvider><InlineProperties path={path} /></MantineProvider>) })
  await settle()
}

/** MantineProvider injects <style> tags into the container, so check the block itself. */
const block = () => container.querySelector('div.empty\\:hidden')
const toggle = () => container.querySelector<HTMLButtonElement>('button[aria-expanded]')

describe('InlineProperties — Wikilinks', () => {
  beforeEach(() => {
    // MantineProvider reads the color scheme from matchMedia, which jsdom lacks.
    window.matchMedia ??= (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null }) as MediaQueryList
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    invokeMock.mockReset()
    openFile.mockReset()
    useEditorStore.setState({ openFile })
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    container.remove()
  })

  it('asks the backend for the backlinks of the given path', async () => {
    invokeMock.mockResolvedValue('[]')
    await render('Notes/Roadmap.md')
    expect(invokeMock).toHaveBeenCalledWith('wiki_backlinks', { path: 'Notes/Roadmap.md' })
  })

  it('renders nothing when no note links here', async () => {
    invokeMock.mockResolvedValue('[]')
    await render()
    expect(block()!.childElementCount).toBe(0)
    expect(toggle()).toBeNull()
  })

  it('renders nothing on a malformed backend reply instead of throwing', async () => {
    invokeMock.mockResolvedValue('not json')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await render()
    expect(block()!.childElementCount).toBe(0)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('shows a collapsed Wikilinks row with the note count', async () => {
    invokeMock.mockResolvedValue(JSON.stringify(BACKLINKS))
    await render()
    expect(container.textContent).toContain('Wikilinks')
    expect(toggle()!.textContent).toContain('2 notes')
    expect(toggle()!.getAttribute('aria-label')).toBe('Wikilinks: 2 linked notes')
    expect(toggle()!.getAttribute('aria-expanded')).toBe('false')
  })

  it('uses the singular for one note', async () => {
    invokeMock.mockResolvedValue(JSON.stringify(BACKLINKS.slice(1)))
    await render()
    expect(toggle()!.textContent).toContain('1 note')
    expect(toggle()!.getAttribute('aria-label')).toBe('Wikilinks: 1 linked note')
  })

  it('expands into a tree of notes: name without .md, parent folder, snippet', async () => {
    invokeMock.mockResolvedValue(JSON.stringify(BACKLINKS))
    await render()
    await act(async () => { toggle()!.click() })
    expect(toggle()!.getAttribute('aria-expanded')).toBe('true')
    const rows = Array.from(container.querySelectorAll('li'))
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('2026-11-03')
    expect(rows[0].textContent).not.toContain('.md')
    expect(rows[0].textContent).toContain('Daily')
    expect(rows[0].textContent).toContain('update [[Roadmap]] hari ini')
    expect(rows[1].textContent).toBe('Ideas')
  })

  it('opens the linking note with its basename as the tab title, like every other openFile caller', async () => {
    invokeMock.mockResolvedValue(JSON.stringify(BACKLINKS))
    await render()
    await act(async () => { toggle()!.click() })
    await act(async () => { container.querySelectorAll<HTMLButtonElement>('li button')[1].click() })
    expect(openFile).toHaveBeenCalledWith('Ideas.md', 'Ideas.md')
  })
})
