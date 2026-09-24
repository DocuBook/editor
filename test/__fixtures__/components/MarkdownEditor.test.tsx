// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownEditor } from '../../../frontend/components/editor/previews'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | null

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  root = createRoot(document.getElementById('root')!)
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
})

describe('MarkdownEditor cursor synchronization', () => {
  it('focuses raw markdown at restored paragraph offset', () => {
    const content = 'First\n\nSecond\n\nThird\n\nFourth paragraph'
    const offset = content.indexOf('Fourth')

    act(() => root!.render(
      <MarkdownEditor content={content} cursorOffset={offset} onCursorOffset={() => {}} onChange={() => {}} />,
    ))

    const textarea = document.querySelector('textarea')!
    expect(document.activeElement).toBe(textarea)
    expect(textarea.selectionStart).toBe(offset)
    expect(textarea.selectionEnd).toBe(offset)
  })

  it('reports raw markdown selection for WYSIWYG restoration', () => {
    const onCursorOffset = vi.fn()
    act(() => root!.render(
      <MarkdownEditor content={'First\n\nFourth'} onCursorOffset={onCursorOffset} onChange={() => {}} />,
    ))
    const textarea = document.querySelector('textarea')!
    const offset = textarea.value.indexOf('Fourth')

    act(() => {
      textarea.focus()
      textarea.setSelectionRange(offset, offset)
      textarea.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }))
    })

    expect(onCursorOffset).toHaveBeenLastCalledWith(offset)
  })
})

/* Tokenising is a whole-document parse, so a long note must not pay for it inside
   the keystroke that changed it. Short notes are unaffected: they stay coloured
   in the same render. */
describe('MarkdownEditor colouring budget', () => {
  const LONG = '# Long\n\n' + 'plain text line\n'.repeat(400)

  const page = () => ({
    pre: document.querySelector('[data-testid="raw-markdown-highlight"]') as HTMLElement,
    textarea: document.querySelector('textarea') as HTMLTextAreaElement,
  })
  const render = (content: string) => act(() => root!.render(
    <MarkdownEditor content={content} onCursorOffset={() => {}} onChange={() => {}} />,
  ))

  it('colours a short note during the render that changed it', () => {
    render('# H\n\n**bold**\n')
    const { pre, textarea } = page()
    expect(pre.querySelector('.md-heading')).not.toBeNull()
    expect(pre.querySelector('.md-strong')).not.toBeNull()
    expect(pre.classList.contains('invisible')).toBe(false)
    expect(textarea.className).toContain('text-transparent')
  })

  it('debounces a long note, revealing the textarea until the colour lands', async () => {
    vi.useFakeTimers()
    try {
      render(LONG)
      const { pre, textarea } = page()
      /* Nothing truthful to paint yet, so the textarea shows its own text and the
         layer stays hidden rather than showing stale colour. */
      expect(pre.querySelector('.md-heading')).toBeNull()
      expect(pre.classList.contains('invisible')).toBe(true)
      expect(textarea.className).toContain('text-foreground')

      await act(async () => { vi.advanceTimersByTime(200) })
      expect(pre.querySelector('.md-heading')).not.toBeNull()
      expect(pre.classList.contains('invisible')).toBe(false)

      /* The keystroke that edits it is not what tokenises it: the layer reveals
         and the parse waits for the pause. */
      render(LONG + '\nand **bold**\n')
      expect(pre.classList.contains('invisible')).toBe(true)
      expect(textarea.className).toContain('text-foreground')

      await act(async () => { vi.advanceTimersByTime(200) })
      expect(pre.classList.contains('invisible')).toBe(false)
      expect(pre.querySelector('.md-strong')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
