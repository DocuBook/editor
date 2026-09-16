const AI_CURSOR_SELECTOR = '.bn-collaboration-cursor__base[data-active="true"]'

/** Writes below one pixel never survive the next paint: the browser rounds
 *  `scrollTop`, the next frame re-measures the caret as still outside the
 *  margin, and the correction loops. Under a fast stream that reads as
 *  flicker, so ignore anything smaller. */
const MIN_SCROLL_DELTA = 1

/** Nearest element that actually scrolls, else the viewport — the document
 *  scrolls when the editor has no inner scroller. Starts at the caret so every
 *  wrapper between the caret and the window is a candidate. */
function resolveScroller(from: HTMLElement): HTMLElement {
  let scroller: HTMLElement | null = from
  while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement
  return scroller ?? document.documentElement
}

/** Keep the small AI caret inside the visible edge of the scroller. Measuring
 *  the whole writing block is avoided on purpose: once a block grows past the
 *  viewport its bounds stay permanently out of view, which triggers scroll
 *  correction on every streamed mutation.
 *
 *  Scrolls by the minimal delta, and only after the caret crosses `margin`.
 *  Always instant — an animation per streamed frame is unreadable while AI
 *  writes fast, and following the caret is not worth blocking the stream for. */
export function followAiWritingCursor(container: HTMLElement, margin = 32): void {
  const cursor = container.querySelector<HTMLElement>(AI_CURSOR_SELECTOR)
  if (!cursor) return

  const scroller = resolveScroller(cursor)
  const cursorBox = cursor.getBoundingClientRect()
  const scrollerBox = scroller.getBoundingClientRect()

  const bottomEdge = scrollerBox.bottom - margin
  const topEdge = scrollerBox.top + margin
  const target = cursorBox.bottom > bottomEdge
    ? scroller.scrollTop + (cursorBox.bottom - bottomEdge)
    : cursorBox.top < topEdge
      ? scroller.scrollTop - (topEdge - cursorBox.top)
      : scroller.scrollTop

  const delta = Math.round(target) - scroller.scrollTop
  if (Math.abs(delta) < MIN_SCROLL_DELTA) return
  scroller.scrollTop += delta
}

/** Resolve the caret from the editor root on every frame: ProseMirror replaces
 *  block DOM nodes, and a streamed write can move the caret into a block that
 *  is not the one the prompt was anchored to. Scoping the lookup to the anchor
 *  block silently stops scrolling in exactly that case. */
export function followAiWritingCursorInRoot(root: HTMLElement): void {
  followAiWritingCursor(root)
}
