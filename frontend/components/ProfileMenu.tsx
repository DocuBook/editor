import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../stores/auth'
import { ArrowLeft, BriefcaseBusiness, Keyboard, LogOut, Settings, UserRound, Users } from 'lucide-react'
import SidebarPopover from './SidebarPopover'

interface ProfileMenuProps {
  isNative: boolean
  /** Whether the settings surface is showing in the editor container. While it
   *  is, the Settings row becomes "Go Back" so this same menu is the way out. */
  settingsOpen: boolean
  onOpenSettings: () => void
  onCloseSettings: () => void
  onOpenShortcuts: () => void
  onLogout: () => void
}

const menuItem = 'flex w-full items-center gap-2 rounded border-none bg-transparent px-2.5 py-1.5 text-left text-[12px]'

export default function ProfileMenu({ isNative, settingsOpen, onOpenSettings, onCloseSettings, onOpenShortcuts, onLogout }: ProfileMenuProps) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const firstItemRef = useRef<HTMLButtonElement>(null)
  const email = useAuth(state => state.email)
  const close = () => setOpen(false)
  const closeAnd = (action: () => void) => { close(); action() }
  /** Restore focus only AFTER the popover has unmounted. Focusing the trigger
   *  in the same tick as setOpen(false) is undone when React removes the still
   *  mounted menu: the browser blurs the removed descendant to <body>, so the
   *  menu dismisses but focus is left stranded. */
  const wasOpen = useRef(false)
  useEffect(() => {
    if (wasOpen.current && !open) triggerRef.current?.focus()
    wasOpen.current = open
  }, [open])

  useEffect(() => {
    if (!open) return
    firstItemRef.current?.focus()
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close()
    }
    const onMouseDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      /** Claim Escape so no global/drawer handler also reacts and moves focus
       *  after we restore it to the trigger. */
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  return (
    /* Not `relative`: the popover anchors to the parent footer row so it spans
       the sidebar instead of the avatar's width. */
    <div ref={menuRef} className="shrink-0">
      <button ref={triggerRef} type="button" onClick={() => setOpen(value => !value)} aria-label="Open profile menu" aria-expanded={open} title={email || (isNative ? 'Local profile' : 'Profile')}
        className={`flex size-7 cursor-pointer items-center justify-center rounded-full border-none text-foreground-secondary hover:bg-surface-hover hover:text-foreground ${open ? 'bg-surface-hover text-foreground' : 'bg-surface-active'}`}>
        <UserRound size={15} />
      </button>
      {open && (
        <SidebarPopover side="top">
          <div className="px-2.5 py-2">
            <div className="flex items-center gap-2 text-foreground"><UserRound size={15} className="shrink-0 text-foreground-subtle" /><span className="truncate text-[12px] font-medium">{email || (isNative ? 'Local user' : 'Account')}</span></div>
          </div>
          <div className="my-1 border-t border-border-subtle" />
          <button type="button" disabled title="Coming soon" className={`${menuItem} cursor-not-allowed text-muted opacity-50`}><Users size={14} /> Invite members</button>
          <button type="button" disabled title="Coming soon" className={`${menuItem} cursor-not-allowed text-muted opacity-50`}><BriefcaseBusiness size={14} /> New workspace</button>
          <div className="my-1 border-t border-border-subtle" />
          <button ref={firstItemRef} type="button" onClick={() => closeAnd(onOpenShortcuts)} className={`${menuItem} cursor-pointer text-foreground-secondary hover:bg-surface-active`}><Keyboard size={14} /> Keyboard shortcuts</button>
          {settingsOpen
            ? <button type="button" onClick={() => closeAnd(onCloseSettings)} className={`${menuItem} cursor-pointer text-foreground-secondary hover:bg-surface-active`}><ArrowLeft size={14} /> Go Back</button>
            : <button type="button" onClick={() => closeAnd(onOpenSettings)} className={`${menuItem} cursor-pointer text-foreground-secondary hover:bg-surface-active`}><Settings size={14} /> Settings</button>}
          {!isNative && <><div className="my-1 border-t border-border-subtle" /><button type="button" onClick={() => closeAnd(onLogout)} className={`${menuItem} cursor-pointer text-danger hover:bg-surface-active`}><LogOut size={14} /> Log out</button></>}
        </SidebarPopover>
      )}
    </div>
  )
}
