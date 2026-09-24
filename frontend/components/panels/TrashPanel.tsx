import { File, Folder, Trash } from 'lucide-react'
import { useRef, useState } from 'react'

import OverlayPortal from '../OverlayPortal'

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
  /** Owned by the parent: a batch action survives this panel unmounting, so
   *  `busy` is not local state — a remount mid-action must not re-enable the
   *  controls or let a second batch start concurrently. */
  busy: boolean
  onRestore: (items: TrashItem[]) => Promise<boolean>
  onDelete: (items: TrashItem[]) => Promise<boolean>
  onBusyChange: (busy: boolean) => void
}

export default function TrashPanel({ items, loading, error, busy, onRestore, onDelete, onBusyChange }: TrashPanelProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmOpen, setConfirmOpen] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const selectedItems = items.filter(item => selected.has(item.name))
  const allSelected = items.length > 0 && selectedItems.length === items.length

  const toggle = (name: string) => setSelected(previous => {
    const next = new Set(previous)
    if (next.has(name)) next.delete(name); else next.add(name)
    return next
  })
  const selectAll = () => setSelected(allSelected ? new Set() : new Set(items.map(item => item.name)))
  const runAction = async (action: (items: TrashItem[]) => Promise<boolean>) => {
    if (!selectedItems.length || busy) return
    onBusyChange(true)
    try {
      const completed = await action(selectedItems)
      if (completed) setSelected(new Set())
    } finally {
      onBusyChange(false)
    }
  }
  const closeConfirm = () => {
    setConfirmOpen(false)
    cancelRef.current?.focus()
  }

  return (
    <section aria-label="Trash" className="flex min-h-0 flex-1 flex-col text-xs">
      <div className="flex items-center gap-0 border-b border-border-subtle px-2 py-2">
        <span className="min-w-0 flex-1 truncate text-muted uppercase tracking-wider">Trash ({items.length})</span>
        <button type="button" onClick={() => void runAction(onRestore)} disabled={!selectedItems.length || busy} className="rounded px-1.5 py-1 text-[11px] text-foreground-secondary cursor-pointer hover:bg-surface-active disabled:cursor-not-allowed disabled:opacity-35">Put back</button>
        <button type="button" onClick={() => { if (!selectedItems.length || busy) return; setConfirmOpen(true) }} disabled={!selectedItems.length || busy} className="rounded px-1.5 py-1 text-[11px] text-danger cursor-pointer hover:bg-danger-surface disabled:cursor-not-allowed disabled:opacity-35">Delete</button>
      </div>

      {error && <div role="alert" className="bg-danger-surface px-3 py-2 text-[10px] text-danger">{error}</div>}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading && items.length === 0 && <div className="p-2 text-center text-foreground-subtle">Loading Trash...</div>}
        {!loading && items.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-foreground-subtle">
            <Trash size={20} />
            <span>Trash is empty</span>
          </div>
        )}
        {items.length > 0 && (
          <label className="mb-1 flex items-center gap-2 rounded px-2 py-1 text-[10px] text-muted hover:bg-surface-active cursor-pointer">
            <input type="checkbox" checked={allSelected} disabled={busy} onChange={selectAll} aria-label="Select all trash items" />
            Select all
          </label>
        )}
        {items.map(item => {
          const ItemIcon = item.is_dir ? Folder : File
          return (
            <label key={item.name} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-surface-active cursor-pointer">
              <input type="checkbox" checked={selected.has(item.name)} disabled={busy} onChange={() => toggle(item.name)} aria-label={`Select ${item.original}`} />
              <ItemIcon size={13} className="shrink-0 text-foreground-subtle" />
              <span className="min-w-0 flex-1 truncate text-foreground-secondary">{item.original}</span>
              {item.deleted_at > 0 && <span className="shrink-0 text-[9px] text-muted">{new Date(item.deleted_at).toLocaleDateString()}</span>}
            </label>
          )
        })}
      </div>

      {confirmOpen && (
        <OverlayPortal>
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label="Delete permanently"
            className="fixed inset-0 z-220 flex items-center justify-center bg-overlay"
            onClick={closeConfirm}
            onKeyDown={e => { if (e.key === 'Escape') closeConfirm() }}
          >
            <div className="ui-popover p-4 w-80" onClick={e => e.stopPropagation()}>
              <div className="text-sm font-semibold mb-1">
                Delete {selectedItems.length === 1 ? `“${selectedItems[0].original}”` : `${selectedItems.length} selected items`} permanently?
              </div>
              <div className="text-xs text-foreground-secondary mb-4">This cannot be undone — the {selectedItems.length === 1 ? 'item' : 'items'} will not go to Trash.</div>
              <div className="flex justify-end gap-2">
                <button ref={cancelRef} autoFocus onClick={closeConfirm} className="text-xs px-3 py-1.5 rounded border border-border-subtle bg-transparent text-foreground-secondary cursor-pointer hover:bg-surface-active">Cancel</button>
                <button onClick={() => { setConfirmOpen(false); void runAction(onDelete) }} className="text-xs px-3 py-1.5 rounded bg-danger text-on-danger cursor-pointer border-none">Delete</button>
              </div>
            </div>
          </div>
        </OverlayPortal>
      )}
    </section>
  )
}
