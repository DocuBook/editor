import type { RefObject } from 'react'
import { SidebarToggle } from './SidebarToggle'
import { TopBarShell } from './TopBarShell'

/** Top chrome for the Settings surface on MOBILE, where the drawer is the only
 *  navigation: without it, opening Settings unmounts the editor's TabBar (the
 *  one place the sidebar toggle lived) and the user is trapped — no way back to
 *  the sidebar tree. It reuses the exact editor chrome (TopBarShell) and the
 *  exact control (SidebarToggle), driven by the SAME App-owned state
 *  (`sidebarOpen`, `toggleSidebar`, `sidebarToggleRef`), so the drawer behaves
 *  identically here and in the editor. Desktop needs none of this: the sidebar
 *  is always rendered beside the pane there. */
export function SettingsHeader({ sidebarOpen, onToggleSidebar, onOpenSearch, sidebarToggleRef }: {
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onOpenSearch: () => void
  sidebarToggleRef: RefObject<HTMLButtonElement | null>
}) {
  return (
    <TopBarShell className="gap-2 pl-4 pr-4">
      <SidebarToggle sidebarOpen={sidebarOpen} isDesktop={false} sidebarToggleRef={sidebarToggleRef} onToggleSidebar={onToggleSidebar} onOpenSearch={onOpenSearch} />
    </TopBarShell>
  )
}
