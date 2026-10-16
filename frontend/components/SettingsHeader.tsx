import type { RefObject } from 'react'
import { SidebarToggle } from './SidebarToggle'
import { TopBarShell } from './TopBarShell'

/** Top chrome for the Settings surface. It reuses the exact editor chrome
 *  (TopBarShell) and the exact control (SidebarToggle), driven by the SAME
 *  App-owned state (`sidebarOpen`, `toggleSidebar`, `sidebarToggleRef`), so the
 *  toggle behaves identically here and in the editor.
 *
 *  Rendered at EVERY width — not just on mobile. The editor's TabBar carries its
 *  own toggle and is always mounted, so gating this header on `!isDesktop` made
 *  Settings the one surface whose chrome could vanish mid-session: a live
 *  breakpoint flip (soft keyboard open/close, rotation) unmounted the header and
 *  left the user with no toggle or search. `isDesktop` is passed THROUGH so the
 *  toggle keeps its per-mode semantics (desktop collapses the pane, mobile opens
 *  the drawer) instead of being pinned to the mobile behavior. */
export function SettingsHeader({ isDesktop, sidebarOpen, onToggleSidebar, onOpenSearch, sidebarToggleRef }: {
  isDesktop: boolean
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onOpenSearch: () => void
  sidebarToggleRef: RefObject<HTMLButtonElement | null>
}) {
  return (
    <TopBarShell className="gap-2 pl-4 pr-4">
      <SidebarToggle sidebarOpen={sidebarOpen} isDesktop={isDesktop} sidebarToggleRef={sidebarToggleRef} onToggleSidebar={onToggleSidebar} onOpenSearch={onOpenSearch} />
    </TopBarShell>
  )
}
