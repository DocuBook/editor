import { useRef, useState } from 'react'
import { Check, ChevronDown, GitBranch, Keyboard } from 'lucide-react'
import ShortcutsModal from './ShortcutsModal'
import { useGitStatus, pollGitStatus } from '../stores/gitStatus'
import { useEditorStore } from '../stores/editor'
import { invoke } from '../lib/ipc'
import { toast } from 'sonner'
import { useClickOutside } from '../hooks/useClickOutside'

interface BranchEntry { name: string; remote: boolean }

/** Sidebar footer for global helpers: shortcuts and the current git branch. */
export default function SidebarFooter() {
  const branch = useGitStatus(s => s.branch)
  const upstream = useGitStatus(s => s.upstream)
  const ahead = useGitStatus(s => s.ahead)
  const behind = useGitStatus(s => s.behind)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [branchOpen, setBranchOpen] = useState(false)
  const [branches, setBranches] = useState<BranchEntry[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const branchRef = useRef<HTMLDivElement>(null)
  useClickOutside(branchRef, () => setBranchOpen(false))

  const toggleBranchSwitcher = async () => {
    const next = !branchOpen
    setBranchOpen(next)
    if (!next) return
    setError('')
    try {
      const res = await invoke<unknown>('git_branches')
      const parsed = typeof res === 'string' ? JSON.parse(res) : res
      setBranches(Array.isArray(parsed) ? parsed.filter((entry: any) => entry && typeof entry.name === 'string') : [])
    } catch (e) { setError(String(e)) }
  }

  const switchBranch = async (entry: BranchEntry) => {
    if (entry.name === branch || busy) return
    setBusy(entry.name)
    setError('')
    try {
      await invoke('git_checkout', { branch: entry.name, remote: entry.remote })
      setBranchOpen(false)
      const dirty = useEditorStore.getState().tabs.filter(tab => tab.dirty).length
      await useEditorStore.getState().reloadAllTabs()
      void pollGitStatus()
      toast.success('Switched to ' + entry.name + (dirty ? ` — ${dirty} unsaved tab${dirty > 1 ? 's' : ''} kept open` : ''))
    } catch (e) { setError(String(e)) }
    finally { setBusy(null) }
  }

  return (
    <div className="ui-shell relative flex items-center gap-1 px-2 py-2 shrink-0">
      <button onClick={() => setShowShortcuts(true)} title="Keyboard Shortcuts" aria-label="Keyboard Shortcuts"
        className="rounded cursor-pointer text-foreground-subtle hover:text-foreground hover:bg-surface-active p-2">
        <Keyboard size={15} />
      </button>
      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}
      {branch ? (
        <div className="flex-1 min-w-0" ref={branchRef}>
          <button onClick={toggleBranchSwitcher} aria-label="Switch branch" aria-expanded={branchOpen} title="Switch branch"
            className="flex items-center gap-1 w-full min-w-0 rounded cursor-pointer text-foreground-subtle hover:text-foreground hover:bg-surface-active px-2 py-2 text-left">
            <GitBranch size={13} className="shrink-0" />
            <span className="font-mono truncate">{branch}</span>
            {upstream ? <span className="text-muted shrink-0">{ahead > 0 && `↑${ahead}`}{behind > 0 && `↓${behind}`}</span> : <span className="text-muted italic text-[10px] shrink-0">no upstream</span>}
            <ChevronDown size={11} className={'ml-auto transition-transform text-muted shrink-0 ' + (branchOpen ? 'rotate-180' : '')} />
          </button>
          {branchOpen && (
            <div className="absolute bottom-full left-2 right-2 mb-1 bg-surface border border-border rounded-lg p-1 max-h-[min(16rem,calc(100dvh-5rem))] overflow-y-auto z-50 shadow-[0_4px_12px_var(--color-shadow)]">
              {branches.length === 0 && !error && <div className="px-2.5 py-1.5 text-[12px] text-muted">No branches found</div>}
              {branches.map(entry => (
                <button key={entry.name} onClick={() => switchBranch(entry)} disabled={busy !== null}
                  className="flex items-center gap-2 w-full px-2.5 py-1.5 cursor-pointer text-[12px] bg-transparent border-none rounded hover:bg-surface-active disabled:opacity-50 disabled:cursor-not-allowed text-left">
                  <GitBranch size={11} className="text-muted shrink-0" />
                  <span title={entry.name} className={'min-w-0 truncate ' + (entry.name === branch ? 'text-foreground font-medium' : 'text-foreground-secondary')}>{entry.name}</span>
                  {entry.remote && <span className="ml-1 shrink-0 text-[10px] text-muted">remote</span>}
                  {entry.name === branch && <Check size={12} className="ml-auto text-accent shrink-0" />}
                  {busy === entry.name && <span className="ml-auto shrink-0 text-[10px] text-muted">switching…</span>}
                </button>
              ))}
              {error && <div className="px-2.5 py-1 text-[10px] text-danger break-words">{error}</div>}
            </div>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-1 flex-1 min-w-0 px-2 py-2 text-muted text-[11px]" title="No git branch available">
          <GitBranch size={13} className="shrink-0" />
          <span>no branch</span>
        </div>
      )}
    </div>
  )
}
