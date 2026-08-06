import { useState } from 'react'
import { GitBranch, CircleHelp } from 'lucide-react'
import ShortcutsModal from './ShortcutsModal'
import { useGitStatus } from '../stores/gitStatus'

/** Bottom status bar showing git branch state (consumes the shared git-status poll). */
export default function StatusBar() {
  const branch = useGitStatus(s => s.branch)
  const [showShortcuts, setShowShortcuts] = useState(false)

  return (
    <footer className="ui-shell h-6 bg-surface border-t border-border-subtle flex items-center text-xs text-zinc-600 shrink-0 px-3 pl-2">
      <button onClick={() => setShowShortcuts(true)} title="Keyboard Shortcuts" className="p-0.5 rounded cursor-pointer bg-transparent text-muted border-none flex items-center mr-2 hover:text-foreground-secondary">
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
