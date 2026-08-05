import { useState, useEffect } from 'react'
import { invoke } from '../lib/ipc'
import { toast } from 'sonner'
import { Plus, X, GitBranch } from 'lucide-react'

interface GitSettingsData {
  isRepo: boolean; noVault: boolean; name: string; email: string
  remotes: { name: string; url: string }[]
}

/** Git settings section: commit identity + remotes + auth guidance. */
export default function GitSettings() {
  const [data, setData] = useState<GitSettingsData | null>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [remoteName, setRemoteName] = useState('origin')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const load = async () => {
    try {
      const d = JSON.parse(await invoke<string>('git_settings'))
      setData(d); setName(d.name); setEmail(d.email); setErr('')
    } catch (e) { setErr(String(e)) }
  }
  useEffect(() => { load() }, [])

  const saveIdentity = async () => {
    setBusy(true); setErr('')
    try { await invoke('git_set_identity', { name, email }); toast.success('Identity saved'); await load() }
    catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }
  const addRemote = async () => {
    setBusy(true); setErr('')
    try { await invoke('git_add_remote', { name: remoteName, url: remoteUrl }); setRemoteUrl(''); await load() }
    catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }
  const removeRemote = async (name: string) => {
    setBusy(true); setErr('')
    try { await invoke('git_remove_remote', { name }); await load() }
    catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }

  const initRepo = async () => {
    setBusy(true); setErr('')
    try { await invoke('git_init'); toast.success('Git repository initialized'); await load() }
    catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }

  if (!data) return <div className="text-xs text-[var(--text-muted)] py-2">Loading git settings…</div>
  if (data.noVault) return (
    <div className="text-xs text-[var(--text-muted)] leading-relaxed">
      No vault is open — open or create a vault first, then return here to set up git (identity, remotes, publishing).
    </div>
  )
  if (!data.isRepo) return (
    <div className="text-xs text-[var(--text-muted)] leading-relaxed flex flex-col gap-3">
      <div>This vault is not a git repository yet — publishing is unavailable until it is. You can initialize one below, or open/clone a git repository from the welcome screen.</div>
      <button onClick={initRepo} disabled={busy} className="self-start px-3 py-1.5 rounded-md bg-[var(--bg-tertiary)] text-[var(--text-primary)] border-none cursor-pointer disabled:opacity-40 text-xs whitespace-nowrap flex items-center gap-1">
        <GitBranch size={12} /> {busy ? 'Initializing…' : 'Initialize git repository'}
      </button>
    </div>
  )

  const inputCls = 'w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-md px-3 py-1.5 text-xs text-[var(--text-primary)] outline-none font-mono'
  return (
    <div className="flex flex-col gap-4 text-xs">
      {/* Commit identity */}
      <div>
        <div className="text-xs font-medium text-[var(--text-primary)] mb-1.5">Commit identity</div>
        <div className="flex gap-2">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Name" className={inputCls} />
          <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" className={inputCls} />
          <button onClick={saveIdentity} disabled={busy} className="shrink-0 px-3 py-1.5 rounded-md bg-[var(--bg-tertiary)] text-[var(--text-primary)] border-none cursor-pointer disabled:opacity-40 text-xs whitespace-nowrap">{busy ? '…' : 'Save'}</button>
        </div>
        <div className="text-[10px] text-[var(--text-muted)] mt-1">Stored per-vault (local git config) — your global git config is untouched. Required before committing.</div>
      </div>

      {/* Remotes */}
      <div>
        <div className="text-xs font-medium text-[var(--text-primary)] mb-1.5">Remotes</div>
        {data.remotes.length === 0
          ? <div className="text-[var(--text-muted)] mb-2">No remotes — add one to push.</div>
          : data.remotes.map(r => (
            <div key={r.name} className="flex items-center gap-2 py-1 border-b border-[var(--border-subtle)] last:border-none">
              <span className="font-mono text-[var(--text-primary)]">{r.name}</span>
              <span className="text-[var(--text-muted)] truncate">{r.url}</span>
              <button onClick={() => removeRemote(r.name)} disabled={busy} aria-label={'Remove ' + r.name} className="ml-auto text-[var(--text-muted)] hover:text-[var(--danger)] cursor-pointer bg-transparent border-none p-0.5"><X size={12} /></button>
            </div>
          ))}
        <div className="flex gap-2 mt-2">
          <input value={remoteName} onChange={e => setRemoteName(e.target.value)} placeholder="origin" className={inputCls + ' !w-24'} />
          <input value={remoteUrl} onChange={e => setRemoteUrl(e.target.value)} placeholder="https://github.com/user/repo.git" className={inputCls} />
          <button onClick={addRemote} disabled={busy || !remoteUrl.trim()} className="shrink-0 px-3 py-1.5 rounded-md bg-[var(--bg-tertiary)] text-[var(--text-primary)] border-none cursor-pointer disabled:opacity-40 text-xs whitespace-nowrap flex items-center gap-1"><Plus size={12} /> Add</button>
        </div>
      </div>

      {/* Auth guidance */}
      <div className="text-[10px] text-[var(--text-muted)] leading-relaxed border-t border-[var(--border-subtle)] pt-3">
        <GitBranch size={11} className="inline mr-1 align-[-1px]" />
        Private repositories need credentials configured on this machine — the app uses them automatically: HTTPS → git credential helper (macOS Keychain), SSH → keys in ~/.ssh. Public repos need no setup.
      </div>
      {err && <div className="text-[11px] text-[var(--danger)]">{err}</div>}
    </div>
  )
}
