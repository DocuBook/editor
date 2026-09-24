import { useFocusTrap } from '@mantine/hooks'
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
 *  above the drawer, whose portal sets an app z-index of 40.
 *
 *  Focus containment travels with the surface: in-tree these elements were part
 *  of the drawer's own trap. Alone, focus falls back into the drawer behind the
 *  overlay on the first Shift+Tab and cannot get back — the drawer trap listens
 *  on document and only wraps within itself — and the menu stops being
 *  reachable from the keyboard at all. The trap re-establishes what leaving the
 *  drawer gave up, focusing the first control (or `[data-autofocus]`) on open.
 *  Both traps coexist: `scopeTab` acts only on events that start at its own
 *  container's boundary.
 *
 *  The hook owns a wrapper element of its own rather than using Mantine's
 *  `<FocusTrap>`, which clone-renders its child and drops any ref the caller
 *  hung there (the context menu's click-outside ref). The wrapper is inert:
 *  every surface it hosts is `position: fixed`, so it stays out of flow. */
export default function OverlayPortal({ children }: { children: ReactNode }) {
  const trapRef = useFocusTrap()
  return createPortal(<div ref={trapRef}>{children}</div>, document.body)
}
