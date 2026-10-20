import { FolderOpen, GitMerge, Trash } from 'lucide-react'

export type SidebarPanelId = 'vault' | 'git' | 'trash'

interface SidebarTabMenuProps {
  active: SidebarPanelId
  onChange: (panel: SidebarPanelId) => void
  /** Locks every tab while a Trash batch action runs — switching panels would
   *  unmount TrashPanel mid-flight and let a second batch start concurrently. */
  disabled?: boolean
}

const ITEMS = [
  { id: 'vault' as const, label: 'Folders', Icon: FolderOpen },
  { id: 'git' as const, label: 'Changes', Icon: GitMerge },
  { id: 'trash' as const, label: 'Trash', Icon: Trash },
]

export default function SidebarTabMenu({ active, onChange, disabled: locked = false }: SidebarTabMenuProps) {
  return (
    <div role="tablist" aria-label="Sidebar panels" className="flex w-full min-w-0 items-center gap-1 rounded-lg border border-border-subtle bg-background p-1">
      {ITEMS.map(({ id, label, Icon }) => {
        const selected = id === active
        /** Every tab is reachable regardless of platform or how full its panel is:
         *  the Trash tab opens and reports "empty" instead of hiding behind a count
         *  gate, which used to make the web build lose the panel entirely until
         *  something had been deleted. Its CONTENT (TrashPanel) still owns the
         *  empty state. Only a running Trash batch locks the tabs. */
        const disabled = locked
        return (
          <button
            key={id}
            role="tab"
            type="button"
            data-testid={id === 'trash' ? 'trash-toggle' : `sidebar-panel-${id}`}
            aria-selected={selected}
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={() => onChange(id)}
            className={
              /** The active tab is sized by its content (`shrink-0`) so the label can
               *  never truncate; icon-only tabs take the slack (`flex-1`) with a 40px
               *  floor, which keeps them tappable instead of the old 28px squares. */
              'inline-flex h-8 items-center justify-center gap-1 rounded-md border-none px-2 text-[11px] transition-colors ' +
              (selected
                ? 'shrink-0 whitespace-nowrap bg-surface-active text-foreground'
                : 'min-w-10 flex-1 bg-transparent text-foreground-subtle hover:bg-surface-hover hover:text-foreground-secondary') +
              (disabled ? ' cursor-not-allowed opacity-35' : ' cursor-pointer')
            }
          >
            <Icon size={14} className="shrink-0" />
            {selected && <span className="whitespace-nowrap font-medium">{label}</span>}
          </button>
        )
      })}
    </div>
  )
}
