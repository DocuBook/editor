import type { ReactNode } from 'react'

/** The editor container's top chrome strip — the full-width bar (surface +
 *  hairline) with a centred, capped inner track. Shared by the editor's TabBar
 *  and the Settings header so both headers sit on the same row height, the same
 *  background and the same drag region instead of two hand-rolled copies that
 *  drift. `className` styles the INNER track (gaps/padding differ per surface);
 *  the outer strip's height and surface are fixed here. */
export function TopBarShell({ dragRegion, className, children }: {
  dragRegion?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <div data-tauri-drag-region={dragRegion ? true : undefined} className="editor-tab-bar relative z-30 h-12 shrink-0">
      <div className={'editor-tab-bar-track ui-shell h-full flex items-center flex-nowrap text-xs ' + (className ?? '')}>
        {children}
      </div>
    </div>
  )
}
