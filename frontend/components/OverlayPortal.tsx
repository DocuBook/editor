import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'

/** Host for surfaces that are positioned against the viewport rather than their
 *  place in the tree — full-screen dialogs and pointer-anchored menus.
 *
 *  The mobile sidebar drawer is why this exists: its slide transition leaves an
 *  inline `transform: translateX(0)` on the drawer content, which makes that
 *  element the containing block for `position: fixed` descendants. In-tree, a
 *  dialog is centred inside the drawer and clipped by the drawer body
 *  (`overflow: hidden`), and a menu is confined to the drawer box, instead of
 *  covering the viewport. Portaling to document.body also keeps the surface
 *  above the drawer, whose portal sets an app z-index of 40. */
export default function OverlayPortal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body)
}
