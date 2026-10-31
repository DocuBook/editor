// @vitest-environment jsdom

/** The compact toolbar's chevron: hidden while the row fits, pages the row
 *  right while there is more, and returns it to the start from the end. jsdom
 *  does no layout, so the row's scroll metrics are set by hand. */

import { forwardRef } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

vi.mock('@blocknote/react', () => ({
  useComponentsContext: () => ({
    FormattingToolbar: {
      Button: forwardRef<HTMLButtonElement, any>(({ label, icon, onClick, className }, ref) => (
        <button ref={ref} type="button" aria-label={label} className={className} onClick={onClick}>{icon}</button>
      )),
    },
  }),
}))

import { ToolbarScrollButton } from '../../../frontend/components/editor/ToolbarScrollButton'

let container: HTMLDivElement
let row: HTMLDivElement
let root: Root

/** Sets the row's scroll metrics, then lets the component re-measure. */
function layout({ scrollWidth, clientWidth, scrollLeft = 0 }: { scrollWidth: number; clientWidth: number; scrollLeft?: number }) {
  Object.defineProperty(row, 'scrollWidth', { configurable: true, value: scrollWidth })
  Object.defineProperty(row, 'clientWidth', { configurable: true, value: clientWidth })
  row.scrollLeft = scrollLeft
}

const button = () => row.querySelector('button')!

beforeEach(() => {
  container = document.createElement('div')
  row = document.createElement('div')
  row.className = 'bn-toolbar'
  row.scrollBy = vi.fn() as any
  row.scrollTo = vi.fn() as any
  container.appendChild(row)
  document.body.appendChild(container)
  root = createRoot(row)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ToolbarScrollButton', () => {
  it('stays hidden while the row fits', () => {
    layout({ scrollWidth: 300, clientWidth: 300 })
    act(() => root.render(<ToolbarScrollButton />))

    expect(button().classList.contains('is-hidden')).toBe(true)
  })

  it('pages the row right while there is more to the right', () => {
    layout({ scrollWidth: 700, clientWidth: 300 })
    act(() => root.render(<ToolbarScrollButton />))

    expect(button().classList.contains('is-hidden')).toBe(false)
    expect(button().getAttribute('aria-label')).toBe('More formatting')

    act(() => button().click())
    expect(row.scrollBy).toHaveBeenCalledWith(expect.objectContaining({ left: 300 }))
    expect(row.scrollTo).not.toHaveBeenCalled()
  })

  it('turns around at the end and returns to the start', () => {
    layout({ scrollWidth: 700, clientWidth: 300 })
    act(() => root.render(<ToolbarScrollButton />))

    layout({ scrollWidth: 700, clientWidth: 300, scrollLeft: 400 })
    act(() => { row.dispatchEvent(new Event('scroll')) })

    expect(button().getAttribute('aria-label')).toBe('Back to start')
    act(() => button().click())
    expect(row.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ left: 0 }))
  })
})
