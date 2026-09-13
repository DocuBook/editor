import { useRef, useState } from 'react'
import { Check, ChevronDown, GitBranch, Keyboard } from 'lucide-react'
import { useGitStatus, pollGitStatus } from '../stores/gitStatus'
import { useEditorStore } from '../stores/editor'
import { invoke } from '../lib/ipc'
import { toast } from 'sonner'
import { useClickOutside } from '../hooks/useClickOutside'

interface BranchEntry { name: string; remote: boolean }

function BranchGroup({ label, branches, current, busy, onSelect }: { label: string; branches: BranchEntry[]; current: string; busy: string | null; onSelect: (entry: BranchEntry) => void }) {
  return (
    <section>
      <div className="px-2.5 pt-1.5 pb-1 text-[10px] uppercase tracking-wider text-foreground-subtle">{label}</div>
      {branches.map(entry => (
        <button key={entry.name} onClick={() => onSelect(entry)} disabled={busy !== null}
          className="flex items-center gap-2 w-full px-2.5 py-1.5 cursor-pointer text-[12px] bg-transparent border-none rounded hover:bg-surface-active disabled:opacity-50 disabled:cursor-not-allowed text-left">
          <GitBranch size={11} className="text-foreground-subtle shrink-0" />
          <span title={entry.name} className={'min-w-0 truncate ' + (entry.name === current ? 'text-foreground' : 'text-foreground-secondary')}>{entry.name}</span>
          {entry.name === current && <Check size={12} className="ml-auto text-accent shrink-0" />}
          {busy === entry.name && <span className="ml-auto shrink-0 text-[10px] text-muted">switching…</span>}
        </button>
      ))}
    </section>
  )
}

/** Sidebar footer for global helpers: shortcuts and the current git branch. */
export default function SidebarFooter({ onOpenShortcuts }: { onOpenShortcuts: () => void }) {
  const branch = useGitStatus(s => s.branch)

  const [branchOpen, setBranchOpen] = useState(false)
  const [branches, setBranches] = useState<BranchEntry[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [newBranchName, setNewBranchName] = useState('')
  const [error, setError] = useState('')
  const branchRef = useRef<HTMLDivElement>(null)
  useClickOutside(branchRef, () => setBranchOpen(false))

  const toggleBranchSwitcher = async () => {
    const next = !branchOpen
    setBranchOpen(next)
    if (!next) return
    setError('')
    setNewBranchName('')
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

  const createBranch = async () => {
    const name = newBranchName.trim()
    if (!name || busy) return
    setBusy(name)
    setError('')
    try {
      await invoke('git_create_branch', { branch: name })
      setBranchOpen(false)
      const dirty = useEditorStore.getState().tabs.filter(tab => tab.dirty).length
      await useEditorStore.getState().reloadAllTabs()
      void pollGitStatus()
      toast.success('Created and switched to ' + name + (dirty ? ` — ${dirty} unsaved tab${dirty > 1 ? 's' : ''} kept open` : ''))
    } catch (e) { setError(String(e)) }
    finally { setBusy(null) }
  }

  const localBranches = branches.filter(entry => !entry.remote)
  const remoteBranches = branches.filter(entry => entry.remote)

  return (
    <div className="ui-shell relative flex items-center gap-1 px-2 py-1 shrink-0">
      <button onClick={onOpenShortcuts} title="Keyboard Shortcuts" aria-label="Keyboard Shortcuts"
        className="rounded cursor-pointer text-foreground-subtle hover:text-foreground hover:bg-surface-active p-2">
        <Keyboard size={15} />
      </button>
      {branch ? (
        <div className="min-w-0 max-w-40" ref={branchRef}>
          <button onClick={toggleBranchSwitcher} aria-label="Switch branch" aria-expanded={branchOpen} title="Switch branch"
            className="flex items-center gap-1 min-w-0 rounded cursor-pointer text-foreground-subtle hover:text-foreground hover:bg-surface-active px-2 py-1.5 text-left">
            <GitBranch size={13} className="shrink-0" />
            <span className="font-mono truncate max-w-28">{branch}</span>

            <ChevronDown size={11} className={'ml-auto transition-transform text-muted shrink-0 ' + (branchOpen ? 'rotate-180' : '')} />
          </button>
          {branchOpen && (
            <div className="ui-popover absolute bottom-full left-2 right-2 mb-1 p-1 z-50">
              <form onSubmit={e => { e.preventDefault(); void createBranch() }} className="px-2 py-1.5 border-b border-border-subtle">
                <input autoFocus value={newBranchName} onChange={e => setNewBranchName(e.target.value)} disabled={busy !== null}
                  placeholder="Type to create a branch..." aria-label="Create branch"
                  className="w-full min-w-0 bg-transparent border-none outline-none text-[12px] text-foreground placeholder:text-muted" />
              </form>
              <div className="max-h-[min(16rem,calc(100dvh-9rem))] overflow-y-auto py-1">
                {localBranches.length > 0 && <BranchGroup label="Local" branches={localBranches} current={branch} busy={busy} onSelect={switchBranch} />}
                {remoteBranches.length > 0 && <BranchGroup label="Remote" branches={remoteBranches} current={branch} busy={busy} onSelect={switchBranch} />}
                {branches.length === 0 && !error && <div className="px-2.5 py-2 text-[11px] text-muted">No branches found</div>}
                {error && <div className="px-2.5 py-1 text-[10px] text-danger wrap-break-word">{error}</div>}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-1 min-w-0 px-2 py-1 text-muted text-[11px]" title="No git branch available">
          <GitBranch size={13} className="shrink-0" />
          <span>no branch</span>
        </div>
      )}
    </div>
  )
}
