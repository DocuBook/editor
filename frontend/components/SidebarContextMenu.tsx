import { useRef } from 'react'
import type { FileInfo } from '../stores/vault'
import { useClickOutside } from '../hooks/useClickOutside'
import OverlayPortal from './OverlayPortal'

interface SidebarContextMenuProps {
  /** The tree row every action applies to. */
  item: FileInfo
  /** Viewport coordinates of the right-click. */
  position: { x: number; y: number }
  onClose: () => void
  /** `kind` picks the flow the caller opens; `item` is where the new entry lands. */
  onCreate: (kind: 'file' | 'folder', item: FileInfo) => void
  onRename: (item: FileInfo) => void
  onDelete: (item: FileInfo) => void
}

/** One menu row: theme tokens only, so it matches the sidebar in both themes.
 *  The colour is added per row — never two colours on one row, since Tailwind
 *  resolves that clash by stylesheet order, not by class order. */
const menuItem = 'flex items-center gap-2 px-2.5 py-1.5 cursor-pointer text-[13px] bg-transparent border-none rounded w-full text-left hover:bg-surface-active'

/** Actions for a vault tree row, anchored at the pointer.
 *
 *  The menu owns its own dismissal and closes itself before handing an action to
 *  the caller, so a row cannot leave a stale menu behind. Focus lands on the menu
 *  itself, never on its first row — otherwise the right-click alone would pre-seat
 *  an action for the next Enter. Adding or reordering an action touches this file
 *  plus one handler prop — never the sidebar's tree rendering. The actions
 *  themselves stay with the caller because they mutate state the sidebar owns:
 *  the inline create input, the rename input, open tabs. */
export default function SidebarContextMenu({ item, position, onClose, onCreate, onRename, onDelete }: SidebarContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  useClickOutside(menuRef, onClose)

  /** Dismiss first: the action may mount an input elsewhere or reload the tree,
   *  and neither should happen with the menu still on screen. */
  const pick = (action: () => void) => { onClose(); action() }

  /** The menu claims focus for itself rather than for its first action — see the
   *  `data-autofocus` below — and these keys are what makes that focus useful.
   *  Escape dismisses, arrows walk the rows and wrap at both ends, Home/End jump. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    const jump = e.key === 'Home' ? 'first' : e.key === 'End' ? 'last' : null
    if (step === 0 && jump === null) return
    e.preventDefault()
    const rows = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    if (rows.length === 0) return
    /** The container itself holds focus until the first arrow, so "nothing
     *  focused" enters the list from the edge that arrow points at. */
    const current = rows.indexOf(document.activeElement as HTMLButtonElement)
    const at = jump === 'first' ? 0
      : jump === 'last' ? rows.length - 1
      : current === -1 ? (step > 0 ? 0 : rows.length - 1)
      : (current + step + rows.length) % rows.length
    rows[at].focus()
  }

  return (
    <OverlayPortal>
      <div ref={menuRef} data-ctx-menu data-autofocus tabIndex={-1} onKeyDown={onKeyDown}
        className="ui-popover fixed p-1 min-w-30 z-100" style={{ top: position.y, left: position.x }}>
        <button onClick={() => pick(() => onCreate('file', item))} className={menuItem + ' text-foreground-secondary'}>New File</button>
        <button onClick={() => pick(() => onCreate('folder', item))} className={menuItem + ' text-foreground-secondary'}>New Folder</button>
        <div className="border-t border-border-subtle my-1" />
        <button onClick={() => pick(() => onRename(item))} className={menuItem + ' text-foreground-secondary'}>Rename</button>
        <button onClick={() => pick(() => onDelete(item))} className={menuItem + ' text-danger'}>Delete</button>
      </div>
    </OverlayPortal>
  )
}
