import { File, Folder, RotateCcw, Trash, Trash2 } from 'lucide-react'

export interface TrashItem {
  name: string
  original: string
  deleted_at: number
  is_dir?: boolean
}

interface TrashPanelProps {
  items: TrashItem[]
  loading: boolean
  error: string
  onRestore: (item: TrashItem) => void
  onDelete: (item: TrashItem) => void
  onEmpty: () => void
  onBack: () => void
}

export default function TrashPanel({ items, loading, error, onRestore, onDelete, onEmpty, onBack }: TrashPanelProps) {
  return (
    <section aria-label="Trash" className="flex min-h-0 flex-1 flex-col text-xs">
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
        <span className="text-muted uppercase tracking-wider">Trash ({items.length})</span>
        <button type="button" onClick={onBack} className="rounded px-1.5 py-1 text-foreground-subtle cursor-pointer hover:bg-surface-active hover:text-foreground-secondary">Back</button>
      </div>

      {error && <div role="alert" className="border-b border-danger/20 bg-danger-surface px-3 py-2 text-[10px] text-danger">{error}</div>}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading && items.length === 0 && <div className="p-2 text-center text-foreground-subtle">Loading Trash...</div>}
        {!loading && items.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-foreground-subtle">
            <Trash size={20} />
            <span>Trash is empty</span>
          </div>
        )}
        {items.map(item => {
          const ItemIcon = item.is_dir ? Folder : File
          return (
            <div key={item.name} className="group flex items-center rounded hover:bg-surface-active">
              <button
                type="button"
                onClick={() => onRestore(item)}
                aria-label={`Put back ${item.original}`}
                title="Put Back"
                className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left cursor-pointer"
              >
                <RotateCcw size={13} className="shrink-0 text-foreground-subtle" />
                <ItemIcon size={13} className="shrink-0 text-foreground-subtle" />
                <span className="min-w-0 flex-1 truncate text-foreground-secondary">{item.original}</span>
                {item.deleted_at > 0 && <span className="shrink-0 text-[9px] text-muted">{new Date(item.deleted_at).toLocaleDateString()}</span>}
              </button>
              <button
                type="button"
                onClick={() => onDelete(item)}
                aria-label={`Delete ${item.original} permanently`}
                title="Delete Permanently"
                className="shrink-0 rounded p-1.5 text-foreground-subtle cursor-pointer hover:bg-danger-surface hover:text-danger"
              >
                <Trash2 size={12} />
              </button>
            </div>
          )
        })}
      </div>

      {items.length > 0 && (
        <button type="button" onClick={onEmpty} className="w-full shrink-0 border-t border-border-subtle bg-transparent py-2 text-[11px] text-danger cursor-pointer hover:bg-surface-active">Empty Trash</button>
      )}
    </section>
  )
}
