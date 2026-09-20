import { AlertTriangle, CloudOff, RefreshCw } from 'lucide-react'

import { useSyncStore } from '../../stores/sync'

/** Always-visible sync state: pending offline writes and unresolved conflicts.
 *
 *  Offline edits are *saved* (queued durably), so without an indicator the user
 *  would have no way to tell that the file on disk is not yet what they see.
 *  Conflicts are surfaced here too, so dismissing the dialog does not hide work
 *  that still needs a decision. Renders nothing when everything is in sync, so
 *  the normal case stays free of chrome. */
export default function SyncStatusBadge() {
  const pending = useSyncStore(s => s.queue.length)
  const conflicts = useSyncStore(s => s.conflicts.length)
  const failures = useSyncStore(s => s.failures.length)
  const draining = useSyncStore(s => s.draining)

  if (pending === 0 && conflicts === 0 && failures === 0) return null

  if (failures > 0) {
    return (
      <div role="status" data-testid="sync-badge" className="flex items-center gap-1.5 border-b border-border-subtle bg-danger px-3 py-1 text-[11px] text-on-danger">
        <AlertTriangle size={12} className="shrink-0" />
        <span>{failures === 1 ? '1 change could not be synced' : `${failures} changes could not be synced`} — your edits are retained; fix or retry them.</span>
      </div>
    )
  }

  if (conflicts > 0) {
    return (
      <div
        role="status"
        data-testid="sync-badge"
        className="flex items-center gap-1.5 border-b border-border-subtle bg-danger px-3 py-1 text-[11px] text-on-danger"
      >
        <AlertTriangle size={12} className="shrink-0" />
        <span>
          {conflicts === 1 ? '1 file needs conflict resolution' : `${conflicts} files need conflict resolution`} — your
          edits are kept, nothing was overwritten.
        </span>
      </div>
    )
  }

  return (
    <div
      role="status"
      data-testid="sync-badge"
      className="flex items-center gap-1.5 border-b border-border-subtle bg-warning px-3 py-1 text-[11px] text-background"
    >
      {draining ? <RefreshCw size={12} className="shrink-0 animate-spin" /> : <CloudOff size={12} className="shrink-0" />}
      <span>
        {pending === 1 ? '1 change waiting to sync' : `${pending} changes waiting to sync`}
        {draining ? ' — syncing…' : ' — saved locally and will sync when the vault is reachable.'}
      </span>
    </div>
  )
}
