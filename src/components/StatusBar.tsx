import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { GitBranch, CircleHelp } from 'lucide-react'
import ShortcutsModal from './ShortcutsModal'
import { usePolling } from '../hooks/usePolling'

/** Bottom status bar showing git branch state. */
export default function StatusBar() {
  const [branch, setBranch] = useState<string | null>(null)
  const [showShortcuts, setShowShortcuts] = useState(false)

  usePolling(() => {
    invoke<string>('git_status').then(s => {
      try { const r = JSON.parse(s); setBranch(r.branch || null) } catch { setBranch(null) }
    }).catch(() => setBranch(null))
  }, 5000)

  return (
    <footer className="ui-shell h-6 bg-[var(--bg-secondary)] border-t border-[var(--border-subtle)] flex items-center text-xs text-zinc-600 shrink-0 px-3 pl-2">
      <button onClick={() => setShowShortcuts(true)} title="Keyboard Shortcuts" className="p-0.5 rounded cursor-pointer bg-transparent text-[var(--text-muted)] border-none flex items-center mr-2 hover:text-zinc-400">
        <CircleHelp size={13} />
      </button>
      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}
      <span className="flex-1" />
      {branch && (
        <span className="flex items-center gap-1 font-mono">
          <GitBranch size={12} />
          {branch}
        </span>
      )}
    </footer>
  )
}
