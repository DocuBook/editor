import { useState, useEffect, useRef } from 'react'
import { invoke } from '../lib/ipc'
import { toast } from 'sonner'
import { Plus, X, GitBranch, RefreshCw } from 'lucide-react'
import { pollGitStatus } from '../stores/gitStatus'

interface GitRemote { name: string; url: string }
interface GitSettingsData {
  isRepo: boolean; noVault: boolean; name: string; email: string
  /** `init.defaultBranch` from git config, else `master` — prefills the branch field. */
  defaultBranch: string
  remotes: GitRemote[]
}
interface InitResult { created: boolean; branch: string }
interface RemoteProbe { reachable: boolean; empty: boolean; defaultBranch: string; branches: number; error: string }

/** Git settings section: commit identity + remotes + auth guidance. */
export default function GitSettings() {
  const [data, setData] = useState<GitSettingsData | null>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [remoteName, setRemoteName] = useState('origin')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [initialBranch, setInitialBranch] = useState('master')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [confirmRemove, setConfirmRemove] = useState<GitRemote | null>(null)
  const cancelRemoveRef = useRef<HTMLButtonElement>(null)
  const [probes, setProbes] = useState<Record<string, RemoteProbe>>({})
  const [remoteBusy, setRemoteBusy] = useState('')
  /** Only the first load prefills the branch field, so a later refresh cannot
   *  clobber a branch name the user is still typing. */
  const branchPrefilled = useRef(false)

  const load = async () => {
    try {
      const d = JSON.parse(await invoke<string>('git_settings'))
      setData(d); setName(d.name); setEmail(d.email); setErr('')
      if (!branchPrefilled.current) { branchPrefilled.current = true; setInitialBranch(d.defaultBranch || 'master') }
    } catch (e) { setErr(String(e)) }
  }
  /* oxlint-disable react/set-state-in-effect -- initial async load */
  useEffect(() => { load() }, [])
  /* oxlint-enable react/set-state-in-effect */

  const saveIdentity = async () => {
    setBusy(true); setErr('')
    try { await invoke('git_set_identity', { name, email }); toast.success('Identity saved'); await load() }
    catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }
  const addRemote = async () => {
    setBusy(true); setErr('')
    try {
      await invoke('git_add_remote', { name: remoteName, url: remoteUrl })
      toast.success(`Remote ${remoteName} added`)
      setRemoteUrl('')
      await load(); await pollGitStatus()
    } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }
  /** Removing a remote is local-only — the hosted repository is untouched. That
   *  is easy to misread, so it is confirmed before it happens. */
  const removeRemote = async (remote: GitRemote) => {
    setConfirmRemove(null)
    setBusy(true); setErr('')
    try {
      await invoke('git_remove_remote', { name: remote.name })
      toast.success(`Remote ${remote.name} removed — the hosted repository is unaffected`)
      await load(); await pollGitStatus()
    } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }

  const initRepo = async () => {
    setBusy(true); setErr('')
    try {
      const res: InitResult = JSON.parse(await invoke<string>('git_init', { branch: initialBranch }))
      toast.success(res.created ? `Git repository initialized on ${res.branch}` : `Already a git repository on ${res.branch}`)
      await load(); await pollGitStatus(true)
    } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }

  /** Connectivity + state of a remote, without transferring objects. An
   *  unreachable remote is reported inline next to it: the probe is a per-remote
   *  diagnostic, and a failed probe leaves the settings form perfectly usable. */
  const checkRemote = async (remote: GitRemote) => {
    setRemoteBusy(remote.name); setErr('')
    try {
      const probe: RemoteProbe = JSON.parse(await invoke<string>('git_remote_probe', { name: remote.name }))
      setProbes(prev => ({ ...prev, [remote.name]: probe }))
    } catch (e) { setProbes(prev => ({ ...prev, [remote.name]: { reachable: false, empty: false, defaultBranch: '', branches: 0, error: String(e) } })) } finally { setRemoteBusy('') }
  }

  /** A modal must be dismissible from the keyboard, not only by clicking it. */
  const cancelRemove = () => {
    setConfirmRemove(null)
    cancelRemoveRef.current?.focus()
  }

  if (!data) return <div className="text-xs text-muted py-2">Loading git settings…</div>
  /** Buttons need to read as buttons: `surface-hover` sits too close to the panel
   *  surface in both themes, so interactive controls carry either an accent fill
   *  (primary), a raised fill plus border (secondary), or the danger token. */
  const btnPrimary = 'px-3 py-1.5 rounded-md bg-accent text-on-accent border-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed text-xs whitespace-nowrap hover:bg-accent-hover transition-colors'
  const btnSecondary = 'px-3 py-1.5 rounded-md bg-surface-active text-foreground border border-border cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed text-xs whitespace-nowrap hover:bg-surface-hover transition-colors'
  const btnDanger = 'px-3 py-1.5 rounded-md bg-danger text-on-danger border-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed text-xs whitespace-nowrap hover:bg-danger-hover transition-colors'
  if (data.noVault) return (
    <div className="text-xs text-muted leading-relaxed">
      No vault is open — open or create a vault first, then return here to set up git (identity, remotes, publishing).
    </div>
  )
  if (!data.isRepo) return (
    <div className="text-xs text-muted leading-relaxed flex flex-col gap-3">
      <div>This vault is not a git repository yet — publishing is unavailable until it is. You can initialize one below, or open/clone a git repository from the welcome screen.</div>
      <label className="flex items-center gap-2 self-start text-muted">
        <span>Default branch</span>
        <input value={initialBranch} onChange={e => setInitialBranch(e.target.value)} placeholder="master" disabled={busy}
          className="w-36 bg-background border border-border rounded-md px-3 py-1.5 text-xs text-foreground outline-none font-mono focus:border-accent" />
      </label>
      <button onClick={initRepo} disabled={busy} className={'self-start flex items-center gap-1 ' + btnPrimary}>
        <GitBranch size={12} /> {busy ? 'Initializing…' : 'Initialize git repository'}
      </button>
      <div className="text-[10px] text-muted">
        This branch name is assumed to match the branch on the remote (e.g. <span className="font-mono">master</span>). If the remote uses another
        name, the first push creates a second branch there instead of updating it. If the repository already exists on GitHub/GitLab, initialize here
        first and then add the remote below — an existing local repository is never re-initialized.
      </div>
      {err && <div className="text-[11px] text-danger">{err}</div>}
    </div>
  )

  const inputCls = 'w-full bg-background border border-border rounded-md px-3 py-1.5 text-xs text-foreground outline-none font-mono focus:border-accent'
  const rowBtnCls = 'px-2 py-0.5 rounded-md bg-surface-active text-foreground-secondary border border-border cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed text-[11px] whitespace-nowrap hover:text-foreground transition-colors'
  return (
    <div className="flex flex-col gap-4 text-xs">
      {/* Commit identity */}
      <div>
        <div className="text-xs font-medium text-foreground mb-1.5">Commit identity</div>
        <div className="flex gap-2">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Name" className={inputCls} />
          <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" className={inputCls} />
          <button onClick={saveIdentity} disabled={busy} className={'shrink-0 ' + btnPrimary}>{busy ? '…' : 'Save'}</button>
        </div>
        <div className="text-[10px] text-muted mt-1">Stored per-vault (local git config) — your global git config is untouched. Required before committing.</div>
      </div>

      {/* Remotes */}
      <div>
        <div className="text-xs font-medium text-foreground mb-1.5">Remotes</div>
        {data.remotes.length === 0
          ? <div className="text-muted mb-2">No remotes — add one to push.</div>
          : data.remotes.map(r => (
            <div key={r.name} className="py-1 border-b border-border-subtle last:border-none">
              <div className="flex items-center gap-2">
                <span className="font-mono text-foreground">{r.name}</span>
                <span className="text-muted truncate">{r.url}</span>
                <div className="ml-auto flex items-center gap-1 shrink-0">
                  <button onClick={() => checkRemote(r)} disabled={remoteBusy === r.name} aria-label={'Check ' + r.name}
                    className={rowBtnCls + ' flex items-center gap-1'}><RefreshCw size={10} /> Check</button>
                  <button onClick={() => setConfirmRemove(r)} disabled={busy} aria-label={'Remove ' + r.name}
                    className="flex size-6 shrink-0 items-center justify-center rounded-md bg-transparent text-foreground-subtle border border-border cursor-pointer hover:text-danger hover:border-danger disabled:opacity-40 disabled:cursor-not-allowed transition-colors"><X size={12} /></button>
                </div>
              </div>
              {probes[r.name] && (
                <div className="text-[10px] text-muted mt-0.5">
                  {probes[r.name].reachable
                    ? probes[r.name].empty
                      ? 'Reachable — no branches yet (push to publish).'
                      : `Reachable — ${probes[r.name].branches} branch(es), default ${probes[r.name].defaultBranch || 'unknown'}.`
                    : <span className="text-danger">Unreachable — {probes[r.name].error}</span>}
                </div>
              )}
            </div>
          ))}
        <div className="flex gap-2 mt-2">
          <input value={remoteName} onChange={e => setRemoteName(e.target.value)} placeholder="origin" className={inputCls + ' w-24!'} />
          <input value={remoteUrl} onChange={e => setRemoteUrl(e.target.value)} placeholder="https://github.com/user/repo.git" className={inputCls} />
          <button onClick={addRemote} disabled={busy || !remoteUrl.trim()} className={'shrink-0 flex items-center gap-1 ' + btnPrimary}><Plus size={12} /> Add</button>
        </div>
        <div className="text-[10px] text-muted mt-1.5 leading-relaxed">
          Multiple remotes are supported: each needs a unique name (e.g. <span className="font-mono">origin</span>, <span className="font-mono">backup</span>).
          Which one Push uses is decided by the current branch: its upstream after the first push, otherwise{' '}
          <span className="font-mono">branch.&lt;branch&gt;.pushRemote</span>, <span className="font-mono">remote.pushDefault</span>, then <span className="font-mono">origin</span>.
          Fetch, Rebase, and Merge live in the Changes panel, where the remote to sync with can be picked.
        </div>
      </div>

      {/* Auth guidance */}
      <div className="text-[10px] text-muted leading-relaxed border-t border-border-subtle pt-3">
        <GitBranch size={11} className="inline mr-1 align-[-1px]" />
        Private repositories need credentials configured on this machine — the app uses them automatically: HTTPS → git credential helper (macOS Keychain), SSH → keys in ~/.ssh. Public repos need no setup.
      </div>
      {err && <div className="text-[11px] text-danger">{err}</div>}

      {confirmRemove && (
        <div role="alertdialog" aria-modal="true" aria-label="Remove remote" className="fixed inset-0 z-220 flex items-center justify-center bg-overlay" onClick={cancelRemove} onKeyDown={e => { if (e.key === 'Escape') cancelRemove() }}>
          <div className="ui-popover p-4 w-80" onClick={e => e.stopPropagation()}>
            <div className="text-sm font-semibold mb-1">Remove remote “{confirmRemove.name}”?</div>
            <div className="text-xs text-foreground-secondary mb-2 break-all font-mono">{confirmRemove.url}</div>
            <div className="text-xs text-foreground-secondary mb-4">This only unlinks the remote from this local repository — the hosted repository and its history are not deleted.</div>
            <div className="flex justify-end gap-2">
              <button ref={cancelRemoveRef} autoFocus onClick={cancelRemove} className={'border border-border bg-transparent text-foreground-secondary hover:bg-surface-active ' + btnSecondary}>{'Cancel'}</button>
              <button onClick={() => void removeRemote(confirmRemove)} className={btnDanger}>Remove</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
