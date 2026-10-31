/** Scrolls the compact (<640px web) formatting toolbar — the trigger that
 *  replaced its "More formatting" overflow panel.
 *
 *  The compact row holds every button and is capped at the viewport width
 *  (`.formatting-toolbar-scroll` in index.css), so the tail that used to land
 *  past the viewport edge now scrolls inside the bubble. A swipe reaches it on
 *  touch; this chevron is the visible cue that there is more, and the way a
 *  mouse gets there. Pinned to the row's trailing edge, it pages the row right;
 *  once the end is reached it turns around and returns to the start, so a mouse
 *  is never stranded at the tail.
 *
 *  Hidden while the row fits. It starts hidden and is measured without its own
 *  width, so a row that fits only once the chevron is gone does not keep it. */
import { useLayoutEffect, useRef, useState, type ComponentProps, type ComponentType, type Ref } from 'react'
import { useComponentsContext } from '@blocknote/react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

export function ToolbarScrollButton() {
  const Components = useComponentsContext()!
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [overflows, setOverflows] = useState(false)
  const [atEnd, setAtEnd] = useState(false)
  /** `ToolbarButtonType` omits `ref`, but the Mantine button is a forwardRef. */
  const Button = Components.FormattingToolbar.Button as ComponentType<
    ComponentProps<typeof Components.FormattingToolbar.Button> & { ref?: Ref<HTMLButtonElement> }
  >

  useLayoutEffect(() => {
    const row = buttonRef.current?.closest<HTMLElement>('.bn-toolbar')
    if (!row) return
    const update = () => {
      setOverflows(row.scrollWidth > row.clientWidth + 1)
      setAtEnd(row.scrollLeft + row.clientWidth >= row.scrollWidth - 1)
    }
    update()
    row.addEventListener('scroll', update, { passive: true })
    /* The row's own size, and the buttons that come and go with the selection
       (the file and table controls) — either can start or end an overflow. */
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    resize?.observe(row)
    const children = new MutationObserver(update)
    children.observe(row, { childList: true })
    return () => {
      row.removeEventListener('scroll', update)
      resize?.disconnect()
      children.disconnect()
    }
  }, [])

  const scroll = () => {
    const row = buttonRef.current?.closest<HTMLElement>('.bn-toolbar')
    if (!row) return
    const behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    /* A page minus the chevron's own width, so the button it covered last is the
       first one in view after the scroll. */
    if (atEnd) row.scrollTo({ left: 0, behavior })
    else row.scrollBy({ left: row.clientWidth - (buttonRef.current?.offsetWidth ?? 0), behavior })
  }

  const label = atEnd ? 'Back to start' : 'More formatting'
  return (
    <Button
      ref={buttonRef}
      className={'bn-button formatting-toolbar-pinned' + (overflows ? '' : ' is-hidden')}
      label={label}
      mainTooltip={label}
      icon={atEnd ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
      onClick={scroll}
    />
  )
}
