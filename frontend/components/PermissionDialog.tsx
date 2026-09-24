import { ShieldAlert } from 'lucide-react'
import { useState } from 'react'

import { openSystemSettings, type SystemSettingsPane } from '../lib/ipc'
import OverlayPortal from './OverlayPortal'

interface PermissionDialogProps {
  /** Which macOS privacy pane the action needs. */
  pane: SystemSettingsPane
  message: string
  /** Extra context: what the user was doing when it failed. */
  detail?: string
  onClose: () => void
}

/** macOS privacy gate — shown instead of a toast when a trash action fails for
 *  want of a permission. A toast only tells the user something is wrong; this
 *  lands them on the exact System Settings pane they must toggle, which is the
 *  only step that actually unblocks them. */
export default function PermissionDialog({ pane, message, detail, onClose }: PermissionDialogProps) {
  const [openFailed, setOpenFailed] = useState(false)
  const paneLabel = pane === 'accessibility' ? 'Accessibility' : pane === 'files' ? 'Full Disk Access' : 'Automation'

  return (
    <OverlayPortal>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label="Permission required"
        className="fixed inset-0 z-220 flex items-center justify-center bg-overlay"
        onClick={onClose}
        onKeyDown={e => { if (e.key === 'Escape') onClose() }}
      >
        <div className="ui-popover p-4 w-96" onClick={e => e.stopPropagation()}>
          <div className="mb-2 flex items-center gap-2">
            <ShieldAlert size={16} className="shrink-0 text-danger" />
            <div className="text-sm font-semibold">Permission required</div>
          </div>
          <div className="mb-2 text-xs text-foreground-secondary">{message}</div>
          {detail && <div className="mb-2 break-all rounded bg-surface-active px-2 py-1 text-[11px] text-muted font-mono">{detail}</div>}
          <div className="mb-4 text-xs text-foreground-secondary">
            Open <span className="text-foreground">System Settings › Privacy &amp; Security › {paneLabel}</span> and enable
            DocuBook Editor, then try again.
          </div>
          {/* Only reachable when the deep link itself fails, which leaves the
              written path above as the sole way forward — so the dialog stays
              open instead of closing on a click that did nothing. */}
          {openFailed && (
            <div role="alert" className="mb-3 text-[11px] text-danger">
              System Settings could not be opened automatically. Follow the path above.
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="text-xs px-3 py-1.5 rounded border border-border-subtle bg-transparent text-foreground-secondary cursor-pointer hover:bg-surface-active">Not now</button>
            {/* The opening control takes initial focus, ahead of "Not now": the
                dialog exists to send the user to System Settings, and the trap
                owns focus order, so it is claimed with Mantine's marker. */}
            <button
              data-autofocus
              onClick={() => {
                void openSystemSettings(pane).then(opened => {
                  if (opened) onClose(); else setOpenFailed(true)
                })
              }}
              className="text-xs px-3 py-1.5 rounded bg-accent text-on-accent cursor-pointer border-none hover:bg-accent-hover"
            >
              Open System Settings
            </button>
          </div>
        </div>
      </div>
    </OverlayPortal>
  )
}
