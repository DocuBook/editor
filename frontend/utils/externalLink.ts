/** Opening an external URL, with the app's URL allowlist applied first.
 *
 *  Link targets come from note content, which is untrusted. Handing an
 *  arbitrary scheme to the OS opener (or a browser tab) would let a note launch
 *  `javascript:`, `file:`, or a custom protocol handler — so every external
 *  open in the app goes through {@link safeExternalUrl}.
 *
 *  Shared by the link toolbar's "Open" button and the editor's in-document link
 *  clicks (see `linkClickPolicy`): two entry points, one policy. */
import { toast } from 'sonner'
import { safeExternalUrl } from './linkInput'

/** Open `url` in the system browser: tauri-plugin-opener on desktop (macOS
 *  `open` → default browser), `window.open` on web. Both runtimes behave the
 *  same for the user (ADR D10 parity).
 *
 *  The URL is re-validated here rather than trusting the caller, so a new call
 *  site cannot accidentally forward an unchecked string. */
export async function openExternalLink(url: string): Promise<void> {
  const safe = safeExternalUrl(url)
  if (!safe) {
    toast.error('Blocked link: unsupported or unsafe URL')
    return
  }
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(safe)
  } catch {
    window.open(safe, '_blank', 'noopener,noreferrer')
  }
}
