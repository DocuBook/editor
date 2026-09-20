/** "Opening a vault…" overlay shown while a vault is being opened.
 *
 *  Gated by `DELAY_MS`: opens faster than that — the common case for a small
 *  vault — render nothing, so this adds no flash and no perceived regression. */
import { useEffect, useState } from 'react'
import { Loader } from 'lucide-react'

/** Wait this long before showing anything. Matches the ~100ms budget an open is
 *  expected to stay under; anything slower is worth an honest loading state. */
const DELAY_MS = 100

export function VaultOpenOverlay({ name, startedAt }: { name?: string; startedAt: number }) {
  const [visible, setVisible] = useState(() => performance.now() - startedAt >= DELAY_MS)

  useEffect(() => {
    if (visible) return
    const timer = setTimeout(() => setVisible(true), Math.max(0, DELAY_MS - (performance.now() - startedAt)))
    return () => clearTimeout(timer)
  }, [visible, startedAt])

  if (!visible) return null
  return (
    <div className="flex flex-col items-center gap-3" role="status" aria-live="polite">
      <Loader size={18} className="animate-spin text-muted" />
      <div className="text-sm text-foreground-secondary">
        Opening {name ? <span className="font-medium text-foreground">{name}</span> : 'a vault'}…
      </div>
    </div>
  )
}
