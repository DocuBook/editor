import { describe, expect, it, vi } from 'vitest'
import { followAiWritingCursor } from '../../../frontend/utils/aiFollowScroll'

const rect = (top: number, bottom: number) => ({ top, bottom }) as DOMRect

function elements(cursorBox: DOMRect | null) {
  const cursor = cursorBox && { getBoundingClientRect: () => cursorBox, scrollIntoView: vi.fn() }
  const scroller = {
    scrollHeight: 1000,
    clientHeight: 200,
    scrollTop: 100,
    parentElement: null,
    getBoundingClientRect: () => rect(0, 200),
  }
  const block = {
    parentElement: scroller,
    querySelector: vi.fn(() => cursor),
    getBoundingClientRect: vi.fn(() => rect(-500, 700)),
  }
  return { block: block as unknown as HTMLElement, scroller, cursor }
}

describe('AI writing follow scroll', () => {
  it('does not measure or scroll an oversized block when the cursor is visible', () => {
    const { block, scroller } = elements(rect(100, 120))

    followAiWritingCursor(block)

    expect(block.getBoundingClientRect).not.toHaveBeenCalled()
    expect(scroller.scrollTop).toBe(100)
  })

  it('scrolls only the minimal cursor delta', () => {
    const { block, scroller } = elements(rect(210, 220))

    followAiWritingCursor(block)

    expect(scroller.scrollTop).toBe(152)
  })

  it('does nothing while xl-ai has no rendered cursor', () => {
    const { block, scroller } = elements(null)

    followAiWritingCursor(block)

    expect(scroller.scrollTop).toBe(100)
    expect(block.getBoundingClientRect).not.toHaveBeenCalled()
  })
})
