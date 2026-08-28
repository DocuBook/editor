import { useRef, useState } from 'react'
import { GitBranch, CircleHelp, Check, ChevronDown } from 'lucide-react'
import ShortcutsModal from './ShortcutsModal'
import { useGitStatus, pollGitStatus } from '../stores/gitStatus'
import { useEditorStore } from '../stores/editor'
import { invoke } from '../lib/ipc'
import { toast } from 'sonner'
import { useClickOutside } from '../hooks/useClickOutside'

interface BranchEntry {
  name: string
  /** true = remote-tracking ref (`origin/dev`) — switching creates a local tracking branch. */
  remote: boolean
}

/** Bottom status bar: keyboard shortcuts + git branch state.
 *  The branch chip shows the local↔remote relation — ↑ahead / ↓behind, or a
 *  "(no upstream)" hint for a branch that was never pushed — and opens a
 *  branch switcher listing LOCAL and REMOTE branches from the actual refs.
 *  After switching, open tabs are reloaded from disk (dirty tabs kept). */
export default function StatusBar() {
  const branch = useGitStatus(s => s.branch)
  const upstream = useGitStatus(s => s.upstream)
  const ahead = useGitStatus(s => s.ahead)
  const behind = useGitStatus(s => s.behind)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState<BranchEntry[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)
  useClickOutside(boxRef, () => setOpen(false))

  const toggleSwitcher = async () => {
    const next = !open
    setOpen(next)
    if (!next) return
    setError('')
    try {
      const res = await invoke<unknown>('git_branches')
      const parsed = typeof res === 'string' ? JSON.parse(res) : res
      /** Normalize — never trust the response shape; an unexpected payload
       *  (null/undefined/object) must not crash the popup render. */
      setBranches(Array.isArray(parsed) ? parsed.filter((b: any) => b && typeof b.name === 'string') : [])
    } catch (e) { setError(String(e)) }
  }

  const switchTo = async (entry: BranchEntry) => {
    if (entry.name === branch || busy) return
    setBusy(entry.name)
    setError('')
    try {
      await invoke('git_checkout', { branch: entry.name, remote: entry.remote })
      setOpen(false)
      const dirty = useEditorStore.getState().tabs.filter(t => t.dirty).length
      await useEditorStore.getState().reloadAllTabs()
      void pollGitStatus()
      toast.success('Switched to ' + entry.name + (dirty ? ` — ${dirty} unsaved tab${dirty > 1 ? 's' : ''} kept open` : ''))
    } catch (e) { setError(String(e)) }
    finally { setBusy(null) }
  }

  return (
    <footer className="ui-shell h-6 bg-surface border-t border-border-subtle flex items-center text-xs text-zinc-600 shrink-0 px-3 pl-2">
      <button onClick={() => setShowShortcuts(true)} title="Keyboard Shortcuts" className="p-0.5 rounded cursor-pointer bg-transparent text-muted border-none flex items-center mr-2 hover:text-foreground-secondary">
        <CircleHelp size={13} />
      </button>
      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}
      <span className="flex-1" />
      {branch && (
        <div className="relative" ref={boxRef}>
          <button onClick={toggleSwitcher} aria-label="Switch branch" aria-expanded={open} title="Switch branch"
            className="flex items-center gap-1 font-mono p-0.5 rounded cursor-pointer bg-transparent border-none hover:bg-surface-active">
            <GitBranch size={12} />
            {branch}
            {upstream ? (
              <span className="text-muted">
                {ahead > 0 && `↑${ahead}`}{behind > 0 && `↓${behind}`}
              </span>
            ) : (
              <span className="text-muted italic">no upstream</span>
            )}
            <ChevronDown size={11} className={'transition-transform text-muted ' + (open ? 'rotate-180' : '')} />
          </button>
          {open && (
            <div className="absolute bottom-full right-0 mb-1 bg-surface border border-border rounded-lg p-1 min-w-[200px] z-50 shadow-[0_4px_12px_rgba(0,0,0,0.3)]">
              {branches.length === 0 && !error && <div className="px-2.5 py-1.5 text-[12px] text-muted">No branches found</div>}
              {branches.map(b => (
                <button key={b.name} onClick={() => switchTo(b)} disabled={busy !== null}
                  className="flex items-center gap-2 w-full px-2.5 py-1.5 cursor-pointer text-[12px] bg-transparent border-none rounded hover:bg-surface-active disabled:opacity-50 disabled:cursor-not-allowed text-left">
                  <GitBranch size={11} className="text-muted shrink-0" />
                  <span className={b.name === branch ? 'text-foreground font-medium' : 'text-foreground-secondary'}>{b.name}</span>
                  {b.remote && <span className="ml-1 text-[10px] text-muted">remote</span>}
                  {b.name === branch && <Check size={12} className="ml-auto text-accent shrink-0" />}
                  {busy === b.name && <span className="ml-auto text-[10px] text-muted">switching…</span>}
                </button>
              ))}
              {error && <div className="px-2.5 py-1 text-[10px] text-red-400 break-words max-w-[240px]">{error}</div>}
            </div>
          )}
        </div>
      )}
    </footer>
  )
}
