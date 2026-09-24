// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { followAiWritingCursor, followAiWritingCursorInRoot } from '../../../frontend/utils/aiFollowScroll'

const AI_CURSOR_SELECTOR = '.bn-collaboration-cursor__base[data-active="true"]'
const rect = (top: number, bottom: number) => ({ top, bottom }) as DOMRect

/** `scrollHeight === clientHeight` (0/0) on the caret and the block, so scroller
 *  resolution has to climb past both to reach the overflowing wrapper. */
function nonScrolling(from: unknown) {
  return { ...(from as object), scrollHeight: 0, clientHeight: 0 }
}

function elements(cursorBox: DOMRect | null) {
  const scroller = {
    scrollHeight: 1000,
    clientHeight: 200,
    scrollTop: 100,
    parentElement: null,
    getBoundingClientRect: () => rect(0, 200),
  }
  const block = {
    ...nonScrolling({}),
    parentElement: scroller,
    querySelector: vi.fn(() => cursor),
    getBoundingClientRect: vi.fn(() => rect(-500, 700)),
  }
  const cursor = cursorBox && {
    ...nonScrolling({}),
    parentElement: block,
    getBoundingClientRect: () => cursorBox,
    scrollIntoView: vi.fn(),
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

  it('ignores a sub-pixel delta instead of re-correcting every frame', () => {
    const { block, scroller } = elements(rect(167, 168.4))

    followAiWritingCursor(block)

    expect(scroller.scrollTop).toBe(100)
  })

  it('resolves the caret from the root on every call', () => {
    const { block, scroller, cursor } = elements(rect(210, 220))

    followAiWritingCursorInRoot(block)

    expect(block.querySelector).toHaveBeenCalledWith(AI_CURSOR_SELECTOR)
    expect(scroller.scrollTop).toBe(152)
    expect(cursor?.scrollIntoView).not.toHaveBeenCalled()
  })

  it('falls back to the viewport when no ancestor overflows, without a scrollIntoView jump', () => {
    const viewportRect = vi.spyOn(document.documentElement, 'getBoundingClientRect').mockReturnValue(rect(0, 400))
    const cursor = {
      ...nonScrolling({ parentElement: nonScrolling({ parentElement: null }) }),
      getBoundingClientRect: () => rect(380, 390),
      scrollIntoView: vi.fn(),
    }
    const container = { querySelector: () => cursor }

    followAiWritingCursor(container as unknown as HTMLElement)

    expect(viewportRect).toHaveBeenCalled()
    expect(cursor.scrollIntoView).not.toHaveBeenCalled()
    viewportRect.mockRestore()
  })

  it('does nothing while rust-ai has no rendered cursor', () => {
    const { block, scroller } = elements(null)

    followAiWritingCursor(block)

    expect(scroller.scrollTop).toBe(100)
    expect(block.getBoundingClientRect).not.toHaveBeenCalled()
  })
})
