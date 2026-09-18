// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../frontend/utils/aiMenu', () => ({
  getDefaultAIMenuItems: () => [],
}))

const invokeMock = vi.fn()
vi.mock('../../../frontend/lib/ipc', () => ({
  invoke: (...args: any[]) => invokeMock(...args),
}))

import AiFloatingChat from '../../../frontend/components/editor/AiFloatingChat'
import { useAiChat } from '../../../frontend/stores/aiChat'
import { useAiSettings } from '../../../frontend/stores/aiSettings'
import { useEditorStore } from '../../../frontend/stores/editor'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/** jsdom has no layout, so the dropdown's scroll-into-view is a no-op here. */
Element.prototype.scrollIntoView = () => {}

const files = (names: string[]) => names.map(name => ({ name, path: name, type: '0' }))
const folder = (name: string) => ({ name, path: name, type: '1' })

let root: Root | null
let tree: Record<string, unknown>

function makeAi() {
  return {
    store: { state: { aiMenuState: 'closed' }, subscribe: () => () => {} },
    openAIMenuAtBlock: vi.fn(),
    closeAIMenu: vi.fn(),
    acceptChanges: vi.fn(),
    rejectChanges: vi.fn(),
    abort: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn().mockResolvedValue(undefined),
    invokeAI: vi.fn(),
  }
}

/** React listens for `input`; the native setter bypasses React's value tracker. */
function typeInto(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.setSelectionRange(value.length, value.length)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const options = () => Array.from(document.querySelectorAll('[role="option"]')).map(node => node.textContent ?? '')
const textarea = () => document.querySelector('textarea')!

function render() {
  act(() => root!.render(<AiFloatingChat />))
}

function listTreeCalls() {
  return invokeMock.mock.calls.filter(([cmd]) => cmd === 'list_tree').length
}

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  root = createRoot(document.getElementById('root')!)
  tree = {
    '': [folder('docs'), folder('assets'), ...files(['CHANGELOG.md'])],
    docs: [folder('notes'), ...files(['guide.md', 'CHANGELOG-old.md'])],
    'docs/notes': files(['guide.md']),
    assets: [],
  }
  useAiChat.setState({ expanded: false, input: '', focusRequest: 0, selectionPromptOpen: false, mentionNotice: null })
  useAiSettings.setState({ provider: 'openai', savedProviders: ['openai'] })
  useEditorStore.setState({
    blockEditor: {
      getExtension: () => makeAi(),
      getTextCursorPosition: () => ({ block: { id: 'b1' } }),
      getSelection: () => undefined,
    },
  })
  invokeMock.mockImplementation(async (cmd: string, args: any) => {
    if (cmd !== 'list_tree') return '[]'
    const entry = tree[args?.subpath ?? '']
    if (entry === 'reject') throw new Error('permission denied')
    return JSON.stringify(entry ?? [])
  })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  useEditorStore.setState({ blockEditor: null })
  vi.clearAllMocks()
})

describe('composer @mention picker', () => {
  it('suggests a nested vault file from a partial name', async () => {
    render()
    act(() => typeInto(textarea(), '@old'))
    await settle()

    expect(options().some(label => label.includes('CHANGELOG-old.md'))).toBe(true)
  })

  it('offers folders so a folder mention stays recursive', async () => {
    render()
    act(() => typeInto(textarea(), '@doc'))
    await settle()

    const docs = Array.from(document.querySelectorAll('[role="option"]')).find(node => node.textContent?.includes('docs'))
    expect(docs).toBeDefined()

    act(() => (docs as HTMLButtonElement).click())
    expect(textarea().value).toBe('@docs/ ')
  })

  it('names the folder for rows that share a basename', async () => {
    render()
    act(() => typeInto(textarea(), '@guide'))
    await settle()

    // Two `guide.md` files: the labels must differ, or the user cannot tell them apart.
    const labels = options()
    expect(labels).toHaveLength(2)
    expect(labels[0]).not.toBe(labels[1])
    expect(labels.some(label => label.includes('docs/notes'))).toBe(true)
  })

  it('inserts the full nested path for an ambiguous basename', async () => {
    render()
    act(() => typeInto(textarea(), '@guide'))
    await settle()

    const nested = Array.from(document.querySelectorAll('[role="option"]')).find(node => node.textContent?.includes('docs/notes'))
    act(() => (nested as HTMLButtonElement).click())

    expect(textarea().value).toBe('@docs/notes/guide.md ')
  })

  it('completes the mention on a pointer pick, without Tab or Enter', async () => {
    render()
    act(() => typeInto(textarea(), 'summarise @change'))
    await settle()

    const row = Array.from(document.querySelectorAll('[role="option"]')).find(node => node.textContent?.includes('CHANGELOG.md')) as HTMLButtonElement
    expect(row).toBeDefined()
    // Real press shape: mousedown (composer keeps focus) then click.
    act(() => {
      row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      row.click()
    })

    expect(textarea().value).toBe('summarise @CHANGELOG.md ')
    expect(document.querySelector('[role="listbox"]')).toBeNull()
  })

  it('inserts the row that was picked, not the one the keyboard highlighted', async () => {
    render()
    act(() => typeInto(textarea(), '@guide'))
    await settle()

    // Arrow-down moves the highlight to the second row; the pick still has to
    // insert the row the pointer landed on.
    act(() => textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    const rows = Array.from(document.querySelectorAll('[role="option"]')) as HTMLButtonElement[]
    expect(rows).toHaveLength(2)
    expect(rows[1].getAttribute('aria-selected')).toBe('true')

    act(() => rows[0].click())
    expect(textarea().value).toBe('@docs/guide.md ')
  })

  it('marks the row Enter would pick, so the commit is never blind', async () => {
    render()
    act(() => typeInto(textarea(), '@guide'))
    await settle()

    const rows = () => Array.from(document.querySelectorAll('[role="option"]')) as HTMLButtonElement[]
    expect(rows()).toHaveLength(2)

    // The armed row takes the accent; the hover tint stays off it, or hovering
    // would paint over the highlight and hide where Enter points.
    expect(rows()[0].className).toContain('bg-accent')
    expect(rows()[0].className).toContain('text-on-accent')
    expect(rows()[0].className).not.toContain('hover:bg-surface-active')
    expect(rows()[1].className).not.toContain('bg-accent')
    expect(rows()[1].className).toContain('hover:bg-surface-active')
    // The muted path label is tuned for the dropdown surface, so it flips too.
    expect(rows()[0].querySelector('span')!.className).toContain('text-on-accent')

    act(() => textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))

    expect(rows()[0].className).not.toContain('bg-accent')
    expect(rows()[1].className).toContain('bg-accent')
    expect(rows()[0].querySelector('span')!.className).toContain('text-muted')

    // Enter commits the row carrying the highlight, not the first row.
    act(() => textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(textarea().value).toBe('@docs/notes/guide.md ')
  })

  it('names the armed row from the composer, the element that keeps focus', async () => {
    render()
    const composer = textarea()

    // Closed: nothing to control and nothing armed.
    expect(composer.getAttribute('role')).toBe('combobox')
    expect(composer.getAttribute('aria-expanded')).toBe('false')
    expect(composer.getAttribute('aria-controls')).toBeNull()

    act(() => typeInto(composer, '@guide'))
    await settle()

    // Focus never leaves the composer, so `aria-activedescendant` has to sit on
    // the composer. On the listbox it names a row of an element the user cannot
    // focus, and screen readers announce nothing as the highlight moves.
    const listbox = document.querySelector('[role="listbox"]')!
    expect(composer.getAttribute('aria-expanded')).toBe('true')
    expect(composer.getAttribute('aria-controls')).toBe(listbox.id)
    expect(composer.getAttribute('aria-autocomplete')).toBe('list')
    expect(listbox.getAttribute('aria-activedescendant')).toBeNull()

    const armedId = () => composer.getAttribute('aria-activedescendant')
    expect(armedId()).toBe(listbox.querySelector('[aria-selected="true"]')!.id)

    act(() => composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(armedId()).toBe(Array.from(listbox.querySelectorAll('[role="option"]'))[1].id)

    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(composer.getAttribute('aria-expanded')).toBe('false')
    expect(composer.getAttribute('aria-controls')).toBeNull()
    expect(armedId()).toBeNull()
  })

  it('keeps suggestions when one folder cannot be listed', async () => {
    tree.assets = 'reject'
    render()
    act(() => typeInto(textarea(), '@change'))
    await settle()

    expect(options().some(label => label.includes('CHANGELOG.md'))).toBe(true)
    expect(document.body.textContent).toContain('1 folder could not be read')
  })

  it('walks the vault once per mention session, not per keystroke', async () => {
    render()
    act(() => typeInto(textarea(), '@c'))
    await settle()
    const afterFirst = listTreeCalls()
    expect(afterFirst).toBeGreaterThan(0)

    act(() => typeInto(textarea(), '@ch'))
    act(() => typeInto(textarea(), '@cha'))
    await settle()

    expect(listTreeCalls()).toBe(afterFirst)
  })

  it('never opens the picker while typing an email address', async () => {
    render()
    act(() => typeInto(textarea(), 'me@mail.com'))
    await settle()

    expect(document.querySelector('[role="listbox"]')).toBeNull()
  })

  it('shows what the last request actually retrieved', () => {
    render()
    act(() => useAiChat.setState({ mentionNotice: '1 file in context · 1 skipped (CHANGELOG.md: not_found)' }))

    expect(document.body.textContent).toContain('1 skipped (CHANGELOG.md: not_found)')
  })

  it('narrows the list as the query grows and reports an empty state', async () => {
    render()
    act(() => typeInto(textarea(), '@CHANGELOG'))
    await settle()
    // Substring match, case-insensitive: both changelogs qualify.
    expect([...options()].sort()).toEqual(['CHANGELOG-old.md', 'CHANGELOG.md'])

    act(() => typeInto(textarea(), '@CHANGELOG.md-nope'))
    await settle()
    expect(options()).toEqual([])
    expect(document.body.textContent).toContain('No matching files or folders')
  })

  it('closes on Escape without clearing what the user typed', async () => {
    render()
    act(() => typeInto(textarea(), 'summarise @change'))
    await settle()
    expect(document.querySelector('[role="listbox"]')).not.toBeNull()

    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })

    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(textarea().value).toBe('summarise @change')
  })
})
