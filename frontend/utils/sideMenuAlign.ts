import type { FloatingUIOptions } from '@blocknote/react'

type Middleware = NonNullable<NonNullable<FloatingUIOptions['useFloatingOptions']>['middleware']>[number]

/** A block's first row when it is a box rather than a line of text: the code
 *  block's header, a table's first row, the "Add file" button of a file block
 *  without a URL, a file's name row, the audio player. Upstream offset each of
 *  these by hand, the code block not at all. */
const ROW_BOXES = '.code-block-header, tr, .bn-add-file-button, .bn-file-name-with-icon, .bn-audio'

/** Vertical centre, in viewport px, of the row the side menu belongs to: a
 *  `ROW_BOXES` box, else the first line of the block's own inline content.
 *  `null` for blocks with neither (an image, an embed preview, a math or
 *  diagram block, whose inline content is the source editor in the popup below
 *  its preview) — those keep the menu on the block's top edge, as upstream
 *  does. The block's own content
 *  comes before its children in the DOM, so the first match is never a child
 *  block's. */
export function firstRowCentre(block: Element): number | null {
  const content = block.querySelector('.bn-block-content')
  if (!content) return null
  const box = content.querySelector(ROW_BOXES)
  if (box) {
    const rect = box.getBoundingClientRect()
    return rect.top + rect.height / 2
  }
  const inline = content.querySelector('.bn-inline-content')
  if (!inline || inline.closest('.bn-source-block-popup')) return null
  const style = getComputedStyle(inline)
  const fontSize = parseFloat(style.fontSize)
  const lineHeight = style.lineHeight === 'normal' ? fontSize * 1.2 : parseFloat(style.lineHeight)
  const top = inline.getBoundingClientRect().top + parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth)
  return top + lineHeight / 2
}

/** Replaces BlockNote's `getBlockOffset` (SideMenuController), which hard-codes
 *  a cross-axis offset per block type from upstream's own CSS: headings 1–3
 *  only (4–6 fall to 0 although every heading carries the same 18px top
 *  padding), and nothing for code blocks. Measuring at positioning time follows
 *  this app's heading line-heights and the code block header instead. */
const alignToFirstRow: Middleware = {
  name: 'alignToFirstRow',
  fn: ({ y, rects, elements }) => {
    // "left-start": `y` is the block's top edge. The reference is BlockPopover's
    // virtual element; the block element itself is its `contextElement`.
    const block = (elements.reference as { contextElement?: Element }).contextElement
    if (!block?.isConnected) return {}
    const centre = firstRowCentre(block)
    if (centre === null) return {}
    return { y: y + centre - block.getBoundingClientRect().top - rects.floating.height / 2 }
  },
}

/** Module-level so SideMenuController's memo sees the same object each render. */
export const SIDE_MENU_FLOATING_OPTIONS: Partial<FloatingUIOptions> = {
  useFloatingOptions: { middleware: [alignToFirstRow] },
}
