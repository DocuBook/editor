import { AlertTriangle, CloudOff, RefreshCw } from 'lucide-react'

import { useSyncStore, isSyncRecordInScope } from '../../stores/sync'
import { useVaultStore } from '../../stores/vault'

/** Always-visible sync state: pending offline writes and unresolved conflicts.
 *
 *  Offline edits are *saved* (queued durably), so without an indicator the user
 *  would have no way to tell that the file on disk is not yet what they see.
 *  Conflicts are surfaced here too, so dismissing the dialog does not hide work
 *  that still needs a decision. Renders nothing when everything is in sync, so
 *  the normal case stays free of chrome. */
export default function SyncStatusBadge() {
  const queue = useSyncStore(s => s.queue)
  const conflicts = useSyncStore(s => s.conflicts)
  const failures = useSyncStore(s => s.failures)
  const draining = useSyncStore(s => s.draining)
  const vaultPath = useVaultStore(s => s.vaultPath)

  // Count only the open vault's records: another vault's relative paths name
  // different files, so surfacing them here would be misleading.
  const pending = queue.filter(q => isSyncRecordInScope(q, vaultPath)).length
  const conflictCount = conflicts.filter(c => isSyncRecordInScope(c, vaultPath)).length
  const failureCount = failures.filter(f => isSyncRecordInScope(f, vaultPath)).length

  if (pending === 0 && conflictCount === 0 && failureCount === 0) return null

  if (failureCount > 0) {
    return (
      <div role="status" data-testid="sync-badge" className="flex items-center gap-1.5 border-b border-border-subtle bg-danger px-3 py-1 text-[11px] text-on-danger">
        <AlertTriangle size={12} className="shrink-0" />
        <span>{failureCount === 1 ? '1 change could not be synced' : `${failureCount} changes could not be synced`} — your edits are retained; fix or retry them.</span>
      </div>
    )
  }

  if (conflictCount > 0) {
    return (
      <div
        role="status"
        data-testid="sync-badge"
        className="flex items-center gap-1.5 border-b border-border-subtle bg-danger px-3 py-1 text-[11px] text-on-danger"
      >
        <AlertTriangle size={12} className="shrink-0" />
        <span>
          {conflictCount === 1 ? '1 file needs conflict resolution' : `${conflictCount} files need conflict resolution`} — your
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
