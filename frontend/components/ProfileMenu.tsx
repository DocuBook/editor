import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../stores/auth'
import { BriefcaseBusiness, ChevronDown, Keyboard, LogOut, Settings, UserRound, Users } from 'lucide-react'
import SidebarPopover from './SidebarPopover'

interface ProfileMenuProps {
  isNative: boolean
  onOpenSettings: () => void
  onOpenShortcuts: () => void
  onLogout: () => void
}

const menuItem = 'flex w-full items-center gap-2 rounded border-none bg-transparent px-2.5 py-1.5 text-left text-[12px]'

export default function ProfileMenu({ isNative, onOpenSettings, onOpenShortcuts, onLogout }: ProfileMenuProps) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const firstItemRef = useRef<HTMLButtonElement>(null)
  const email = useAuth(state => state.email)
  const close = () => { setOpen(false); triggerRef.current?.focus() }
  const closeAnd = (action: () => void) => { close(); action() }

  useEffect(() => {
    if (!open) return
    firstItemRef.current?.focus()
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close()
    }
    const onMouseDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close()
    }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={menuRef} className="relative shrink-0 border-t border-border-subtle px-2 py-2">
      <button ref={triggerRef} type="button" onClick={() => setOpen(value => !value)} aria-label="Open profile menu" aria-expanded={open} className="flex w-full cursor-pointer items-center gap-2 rounded-md border-none bg-transparent px-2 py-2 text-left hover:bg-surface-active">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-active text-foreground-secondary"><UserRound size={15} /></span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground-secondary">{email || (isNative ? 'Local profile' : 'Profile')}</span>
        <ChevronDown size={14} aria-hidden="true" className={`shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <SidebarPopover side="top">
          <div className="px-2.5 py-2">
            <div className="flex items-center gap-2 text-foreground"><UserRound size={15} className="shrink-0 text-foreground-subtle" /><span className="truncate text-[12px] font-medium">{email || (isNative ? 'Local user' : 'Account')}</span></div>
            {email && <div className="truncate pl-5.75 pt-0.5 text-[11px] text-muted">{email}</div>}
          </div>
          <div className="my-1 border-t border-border-subtle" />
          <button type="button" disabled title="Coming soon" className={`${menuItem} cursor-not-allowed text-muted opacity-50`}><Users size={14} /> Invite members</button>
          <button type="button" disabled title="Coming soon" className={`${menuItem} cursor-not-allowed text-muted opacity-50`}><BriefcaseBusiness size={14} /> New workspace</button>
          <div className="my-1 border-t border-border-subtle" />
          <button ref={firstItemRef} type="button" onClick={() => closeAnd(onOpenShortcuts)} className={`${menuItem} cursor-pointer text-foreground-secondary hover:bg-surface-active`}><Keyboard size={14} /> Keyboard shortcuts</button>
          <button type="button" onClick={() => closeAnd(onOpenSettings)} className={`${menuItem} cursor-pointer text-foreground-secondary hover:bg-surface-active`}><Settings size={14} /> Settings</button>
          {!isNative && <><div className="my-1 border-t border-border-subtle" /><button type="button" onClick={() => closeAnd(onLogout)} className={`${menuItem} cursor-pointer text-danger hover:bg-surface-active`}><LogOut size={14} /> Log out</button></>}
        </SidebarPopover>
      )}
    </div>
  )
}
