import type { RefObject } from 'react'
import { PanelLeft, Search } from 'lucide-react'

/** The sidebar open/collapse control — the ONE implementation shared by the
 *  editor's TabBar and the Settings header. Both surfaces live in the same
 *  container and swap in and out of it, so the control has to behave the same
 *  in each: desktop collapses the pane, mobile opens/closes the drawer, and a
 *  paired Search button appears once the panel is hidden. Duplicating this
 *  markup is how the two header rows would drift (labels, icons, aria wiring);
 *  `sidebarToggleRef` rides whichever instance is mounted so the drawer's
 *  focus-return still targets the visible button. */
export function SidebarToggle({ sidebarOpen, isDesktop, sidebarToggleRef, onToggleSidebar, onOpenSearch }: {
  sidebarOpen: boolean
  isDesktop: boolean
  sidebarToggleRef: RefObject<HTMLButtonElement | null>
  onToggleSidebar: () => void
  onOpenSearch: () => void
}) {
  return (
    <span className={'inline-flex shrink-0 items-center ' + (sidebarOpen ? '' : 'rounded-md border border-border-subtle bg-background overflow-hidden')}>
      <button
        ref={sidebarToggleRef}
        data-testid="sidebar-toggle"
        onClick={onToggleSidebar}
        aria-label={isDesktop ? (sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar') : (sidebarOpen ? 'Close sidebar drawer' : 'Open sidebar drawer')}
        aria-expanded={sidebarOpen}
        aria-controls={isDesktop ? 'desktop-sidebar' : 'mobile-sidebar'}
        aria-haspopup={isDesktop ? undefined : 'dialog'}
        className="rounded cursor-pointer text-foreground-subtle hover:text-foreground-secondary hover:bg-surface-active p-2"
      >
        <PanelLeft size={16} />
      </button>
      {!sidebarOpen && (
        <button
          onClick={onOpenSearch}
          aria-label="Search files"
          className="cursor-pointer text-foreground-subtle hover:text-foreground-secondary hover:bg-surface-active p-2 border-l border-border-subtle"
        >
          <Search size={16} />
        </button>
      )}
    </span>
  )
}
