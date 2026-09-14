import type { ReactNode } from 'react'

type SidebarPopoverProps = {
  children: ReactNode
  side?: 'top' | 'bottom'
  className?: string
}

/** Shared popover surface for controls owned by the sidebar.
 * The containing block must be the full-width sidebar region. Keeping the
 * panel local (rather than portaling/fixing it) prevents drawer clipping and
 * makes future sidebar menus use the same geometry. */
export default function SidebarPopover({ children, side = 'top', className = '' }: SidebarPopoverProps) {
  const placement = side === 'top' ? 'bottom-full mb-1' : 'top-full mt-1'
  return (
    <div className={`ui-popover absolute inset-x-0 mx-2 w-auto z-100 min-w-0 p-1 ${placement} ${className}`}>
      {children}
    </div>
  )
}
