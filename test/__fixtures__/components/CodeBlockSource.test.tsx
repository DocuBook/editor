// @vitest-environment jsdom

/** The code block source view's contract: header chrome (language picker plus
 *  title input) around an untouched `pre > code` — the shape the AI-writing
 *  freeze, the markdown exporter and the Shiki `language-*`/`data-language`
 *  consumers all read. The picker shows the fence token as-is and reads Shiki's
 *  catalogue only when its dropdown opens, so a raw markdown → WYSIWYG switch
 *  (every code block mounting at once) does no async work. */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
// Mantine's dropdown scrolls inside a ScrollArea, which measures with
// ResizeObserver, and its provider reads the OS colour scheme — jsdom has
// neither.
Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
Object.assign(window, {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }),
})
Object.assign(Element.prototype, { scrollIntoView: () => {} })

// setup.ts reaches the diagram preview module, and that one imports Mermaid
// eagerly — none of it is exercised here, so both are stubbed out.
vi.mock('mermaid', () => ({ default: { render: vi.fn(), initialize: vi.fn() } }))
vi.mock('react-icons/si', () => ({ SiMermaid: () => null }))
vi.mock('@blocknote/diagram-block', () => ({
  createDiagramBlockConfig: () => ({}),
  parseDiagramCodeContent: () => {},
  parseDiagramCodeElement: () => undefined,
  getDiagramDictionary: () => ({ block: {} }),
  initializeMermaid: () => {},
  trimDiagramSVG: (svg: string) => svg,
  withSVGFontFamily: (svg: string) => svg,
}))

const catalogue = vi.hoisted(() => ({ loadCalls: 0 }))
vi.mock('../../../frontend/utils/codeLanguages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../frontend/utils/codeLanguages')>()
  return {
    ...actual,
    loadCodeLanguages: () => { catalogue.loadCalls += 1; return actual.loadCodeLanguages() },
  }
})

import { CodeBlockSource, StableCodeBlockPreview, setPreviewRenderingPaused } from '../../../frontend/components/editor/setup'
import { loadCodeLanguages } from '../../../frontend/utils/codeLanguages'

let container: HTMLDivElement
let root: Root
let updateBlock: ReturnType<typeof vi.fn>

const renderBlock = async (Source: any, info: string, editorOverrides: Record<string, unknown> = {}) => {
  await act(async () => {
    root.render(
      <MantineProvider>
        <Source
          {...({
            block: { id: 'block-1', props: { language: info } },
            editor: { isEditable: true, updateBlock, ...editorOverrides },
            contentRef: () => {},
          } as any)}
        />
      </MantineProvider>,
    )
  })
  await act(async () => {})
}

const renderSource = (info: string) => renderBlock(CodeBlockSource, info)
const languageInput = () => container.querySelector<HTMLInputElement>('.code-block-language-input')!
const titleInput = () => container.querySelector<HTMLInputElement>('input.code-block-title')!

/** Types into the search field the way a user does: React reads value changes
 *  from the input event, so the native setter has to be used. */
const typeSearch = async (text: string) => {
  const input = languageInput()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {})
}

const optionLabels = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.textContent)

/** The options live in a portal on document.body, as they do in the app. */
const openLanguageMenu = async () => {
  const input = languageInput()
  await act(async () => {
    input.focus()
    input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    input.click()
  })
  await act(async () => {})
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')]
}

beforeAll(async () => {
  await loadCodeLanguages()
})

beforeEach(() => {
  catalogue.loadCalls = 0
  updateBlock = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => setPreviewRenderingPaused(false))
  act(() => root.unmount())
  container.remove()
})

describe('codeBlock source view', () => {
  it('keeps pre > code carrying the fence info verbatim', async () => {
    await renderSource('ts title="file.ts"')

    const code = container.querySelector('pre > code')!
    expect(code.className).toBe('language-ts')
    expect(code.getAttribute('data-language')).toBe('ts title="file.ts"')
  })

  it('shows plain text for an empty or `text` info string (insert default)', async () => {
    await renderSource('')
    expect(languageInput().value).toBe('text')

    await renderSource('text')
    expect(languageInput().value).toBe('text')
  })

  it('shows the fence token as-is; only the dropdown resolves names', async () => {
    await renderSource('js title="app.js"')

    expect(languageInput().value).toBe('js')
    expect(titleInput().value).toBe('app.js')
    expect((await openLanguageMenu()).some((option) => option.textContent === 'JavaScript')).toBe(true)
  })

  it('keeps a token outside the Shiki bundle visible instead of swapping it', async () => {
    await renderSource('foo')

    expect(languageInput().value).toBe('foo')
    expect((await openLanguageMenu()).some((option) => option.textContent === 'foo')).toBe(true)
  })

  it('writes a picked language through the info-string helper', async () => {
    await renderSource('js showLineNumbers title="app.js"')

    const python = (await openLanguageMenu()).find((option) => option.textContent === 'Python')
    expect(python).toBeDefined()
    await act(async () => {
      python!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      python!.click()
    })

    expect(updateBlock).toHaveBeenCalledWith('block-1', {
      props: { language: 'python showLineNumbers title="app.js"' },
    })
  })

  it('filters the list as the user types', async () => {
    await renderSource('js')
    await openLanguageMenu()

    await typeSearch('pyth')

    expect(optionLabels()).toEqual(['Python'])
  })

  it('finds a language by its alias and its id, not just its display name', async () => {
    await renderSource('js')
    await openLanguageMenu()

    await typeSearch('js')
    expect(optionLabels()).toContain('JavaScript')

    await typeSearch('ts')
    expect(optionLabels()).toContain('TypeScript')

    await typeSearch('jsonc')
    expect(optionLabels()).toContain('JSON with Comments')
  })

  /** The guard that keeps the code block's Tab/Enter/Delete commands out of the
   *  header must not starve the picker: Mantine drives the list from the
   *  input's own key events (ArrowUp/Down, Enter, Escape). */
  it('drives the dropdown from the keyboard', async () => {
    await renderSource('js')
    await openLanguageMenu()
    await typeSearch('pyth')
    const key = (code: string) => new KeyboardEvent('keydown', { code, key: code, bubbles: true })

    await act(async () => { languageInput().dispatchEvent(key('ArrowDown')) })
    await act(async () => { languageInput().dispatchEvent(key('Enter')) })

    expect(updateBlock).toHaveBeenCalledWith('block-1', { props: { language: 'python' } })
  })

  it('closes the dropdown on Escape', async () => {
    await renderSource('js')
    await openLanguageMenu()
    expect(languageInput().getAttribute('aria-expanded')).toBe('true')

    await act(async () => {
      languageInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    // Mantine keeps the options mounted, so the combobox state is the signal.
    expect(languageInput().getAttribute('aria-expanded')).toBe('false')
  })
})

describe('codeBlock language catalogue', () => {
  /** The race this pins: mounting a document's code blocks (raw markdown →
   *  WYSIWYG) must not start the async import for every block at once. */
  it('is not read while a code block renders, only when the dropdown opens', async () => {
    await renderSource('js title="a.js"')
    expect(catalogue.loadCalls).toBe(0)

    await openLanguageMenu()
    expect(catalogue.loadCalls).toBe(1)
  })
})

describe('codeBlock freeze while the AI writes', () => {
  it('keeps the frozen fence and pre > code, then adopts the written props', async () => {
    await renderBlock(StableCodeBlockPreview, 'ts title="a.ts"')
    expect(languageInput().value).toBe('ts')

    await act(async () => { setPreviewRenderingPaused(true) })
    await renderBlock(StableCodeBlockPreview, 'python title="b.py"')

    // Frozen: the streaming props are ignored, so the rendered fence is still
    // the one that was on screen when writing started — header included.
    expect(languageInput().value).toBe('ts')
    expect(titleInput().value).toBe('a.ts')
    expect(container.querySelector('pre > code')!.getAttribute('data-language')).toBe('ts title="a.ts"')
    // The writing path must not touch the language catalogue at all.
    expect(catalogue.loadCalls).toBe(0)

    await act(async () => { setPreviewRenderingPaused(false) })

    expect(languageInput().value).toBe('python')
    expect(titleInput().value).toBe('b.py')
  })
})
