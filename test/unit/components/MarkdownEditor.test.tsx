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
