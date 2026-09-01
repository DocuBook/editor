const AI_CURSOR_SELECTOR = '.bn-collaboration-cursor__base[data-active="true"]'

/** Keep the small AI caret visible without measuring or scrolling an oversized
 * writing block. Measuring the whole block causes perpetual scroll correction
 * once its height exceeds the viewport. */
export function followAiWritingCursor(block: HTMLElement, margin = 32): void {
  const cursor = block.querySelector<HTMLElement>(AI_CURSOR_SELECTOR)
  if (!cursor) return

  let scroller: HTMLElement | null = block.parentElement
  while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement
  if (!scroller) {
    cursor.scrollIntoView({ block: 'nearest' })
    return
  }

  const cursorBox = cursor.getBoundingClientRect()
  const scrollerBox = scroller.getBoundingClientRect()
  if (cursorBox.bottom > scrollerBox.bottom - margin) {
    scroller.scrollTop += cursorBox.bottom - (scrollerBox.bottom - margin)
  } else if (cursorBox.top < scrollerBox.top + margin) {
    scroller.scrollTop -= (scrollerBox.top + margin) - cursorBox.top
  }
}
