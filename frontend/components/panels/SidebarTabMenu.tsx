import { BotMessageSquare, FolderTree, GitMerge, Trash } from 'lucide-react'

export type SidebarPanelId = 'vault' | 'ai' | 'git' | 'trash'

interface SidebarTabMenuProps {
  active: SidebarPanelId
  onChange: (panel: SidebarPanelId) => void
  trashCount: number
  isNative: boolean
}

const ITEMS = [
  { id: 'vault' as const, label: 'Vault', Icon: FolderTree },
  { id: 'ai' as const, label: 'AI Chat', Icon: BotMessageSquare },
  { id: 'git' as const, label: 'History', Icon: GitMerge },
  { id: 'trash' as const, label: 'Trash', Icon: Trash },
]

export default function SidebarTabMenu({ active, onChange, trashCount, isNative }: SidebarTabMenuProps) {
  return (
    <div role="tablist" aria-label="Sidebar panels" className="flex w-full min-w-0 items-center gap-0.5 rounded-lg border border-border-subtle bg-background p-0.5">
      {ITEMS.map(({ id, label, Icon }) => {
        const selected = id === active
        const disabled = id === 'trash' && !isNative && trashCount === 0
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
              'inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-md border-none px-1.5 text-[11px] transition-colors ' +
              (selected
                ? 'min-w-0 flex-1 bg-surface-active text-foreground'
                : 'shrink-0 bg-transparent text-foreground-subtle hover:bg-surface-hover hover:text-foreground-secondary') +
              (disabled ? ' cursor-not-allowed opacity-35' : ' cursor-pointer')
            }
          >
            <Icon size={14} className="shrink-0" />
            {selected && <span className="min-w-0 truncate font-medium">{label}</span>}
          </button>
        )
      })}
    </div>
  )
}
