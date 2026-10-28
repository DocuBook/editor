// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { settle } from '../harness'

vi.mock('../../../frontend/utils/aiMenu', () => ({
  getDefaultAIMenuItems: () => [],
}))

const invokeMock = vi.fn()
vi.mock('../../../frontend/lib/ipc', () => ({
  invoke: (...args: any[]) => invokeMock(...args),
}))

import AiFloatingChat from '../../../frontend/components/editor/AiFloatingChat'
import { invalidateMentionIndex } from '../../../frontend/utils/mentionIndex'
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
  // The index cache is module state shared across picker openings; each test
  // owns a different tree, so it must not inherit the previous walk.
  invalidateMentionIndex()
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
    // The hint must survive a long name: it keeps its width (capped at half the
    // row) and the name truncates first. jsdom has no layout, so the contract
    // is the classes; the rendered result was checked in Chromium and WebKit.
    for (const row of Array.from(document.querySelectorAll('[role="option"]'))) {
      expect(row.querySelector('span')!.className).toContain('truncate')
      expect(row.querySelector('span + span')!.className).toMatch(/\bshrink-0\b/)
      expect(row.querySelector('span + span')!.className).toContain('max-w-[50%]')
    }
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

  it('leaves the candidate arrows to the IME while it composes', async () => {
    render()
    act(() => typeInto(textarea(), '@guide'))
    await settle()

    const armed = () => Array.from(document.querySelectorAll('[role="option"]')).findIndex(node => node.getAttribute('aria-selected') === 'true')
    expect(armed()).toBe(0)

    // The arrows that walk the IME's candidate strip must not walk this list.
    act(() => textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, isComposing: true })))
    expect(armed()).toBe(0)

    // An arrow after the composition commits still navigates the picker.
    act(() => textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(armed()).toBe(1)
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
    expect(rows()[0].querySelector('span + span')!.className).toContain('text-on-accent')

    act(() => textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))

    expect(rows()[0].className).not.toContain('bg-accent')
    expect(rows()[1].className).toContain('bg-accent')
    expect(rows()[0].querySelector('span + span')!.className).toContain('text-muted')

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

  it('paints the mention tag apart from the prompt text', async () => {
    render()
    act(() => typeInto(textarea(), 'summarise @change'))
    await settle()

    // The tag should read as a token, not as more prompt prose.
    const remove = document.querySelector('button[aria-label="Remove @change"]')!
    expect(remove).not.toBeNull()
    const tag = remove.parentElement!
    expect(tag.className).toContain('bg-accent-subtle')
    expect(tag.className).toContain('text-accent')
    expect(textarea().className).toContain('text-foreground')

    // The remove affordance still works from the tag.
    act(() => (remove as HTMLButtonElement).click())
    expect(textarea().value).toBe('summarise')
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

  /** Reopening the picker used to re-walk every folder. The walk is cached per
   *  vault, so a second `@` in the same session is served from memory. */
  it('reuses the vault index across picker openings', async () => {
    render()
    act(() => typeInto(textarea(), '@c'))
    await settle()
    const firstWalk = listTreeCalls()
    expect(firstWalk).toBeGreaterThan(0)

    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(document.querySelector('[role="listbox"]')).toBeNull()

    act(() => typeInto(textarea(), '@ch'))
    await settle()

    expect(options().length).toBeGreaterThan(0)
    expect(listTreeCalls()).toBe(firstWalk)
  })

  /** A tree reload (create/rename/delete, external refresh) must be reflected
   *  the next time the picker opens. */
  it('re-walks after the index is invalidated', async () => {
    render()
    act(() => typeInto(textarea(), '@c'))
    await settle()
    const firstWalk = listTreeCalls()

    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    invalidateMentionIndex()
    act(() => typeInto(textarea(), '@ch'))
    await settle()

    expect(listTreeCalls()).toBeGreaterThan(firstWalk)
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

/** The @mention list stacks into the composer card like the status bar, the
 *  model picker and the suggestions — it used to float above the card. */
describe('composer @mention panel placement', () => {
  const listbox = () => document.querySelector<HTMLElement>('#mention-listbox')
  const modelListbox = () => document.querySelector('#ai-model-listbox')
  const trigger = () => document.querySelector<HTMLButtonElement>('[aria-label="Select AI model"]')!

  it('stacks inside the composer card, above the prompt box, headed Context', async () => {
    render()
    act(() => typeInto(textarea(), 'summarise @change'))
    await settle()

    const list = listbox()!
    const surface = document.querySelector('.ai-chat-surface')!
    expect(surface.contains(list)).toBe(true)
    // No positioned popover between the list and the card…
    const positioned: Element[] = []
    for (let node = list.parentElement; node && node !== surface; node = node.parentElement) {
      if (node.classList.contains('absolute')) positioned.push(node)
    }
    expect(positioned).toEqual([])
    // …above the prompt box, in its own panel with the shared header.
    expect(list.compareDocumentPosition(textarea()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const panel = list.closest('.ai-chat-panel')!
    expect(panel).not.toBeNull()
    expect(panel.textContent).toContain('Context')
    // The prompt box still drives it.
    expect(textarea().getAttribute('aria-controls')).toBe(list.id)
  })

  it('is one stacked list at a time with the model picker', async () => {
    render()
    act(() => trigger().click())
    await settle()
    expect(modelListbox()).not.toBeNull()

    // Typing `@` replaces the open model picker…
    act(() => typeInto(textarea(), 'summarise @change'))
    await settle()
    expect(listbox()).not.toBeNull()
    expect(modelListbox()).toBeNull()

    // …and opening the picker closes the @mention list.
    act(() => trigger().click())
    await settle()
    expect(modelListbox()).not.toBeNull()
    expect(listbox()).toBeNull()
  })

  it('fits the list into the visual viewport while the keyboard is up', async () => {
    /** Card: bottom edge at 700px, 300px tall, of which the list is 200px. */
    const viewport = Object.assign(new EventTarget(), { offsetTop: 0, height: 900 })
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return (this.classList.contains('ai-chat-surface') ? { top: 400, bottom: 700, height: 300, left: 0, right: 300, width: 300, x: 0, y: 400 } : { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0, x: 0, y: 0 }) as DOMRect
    })
    const offset = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.id === 'mention-listbox' ? 200 : 0
    })
    try {
      render()
      act(() => typeInto(textarea(), 'summarise @change'))
      await settle()
      expect(listbox()!.style.maxHeight).toBe('256px')

      // Keyboard up: 400px visible → 400 − 56 (tab bar) − 100 (rest of card).
      viewport.height = 400
      act(() => { viewport.dispatchEvent(new Event('resize')) })
      expect(listbox()!.style.maxHeight).toBe('244px')
    } finally {
      rect.mockRestore()
      offset.mockRestore()
      delete (window as { visualViewport?: unknown }).visualViewport
    }
  })
})
