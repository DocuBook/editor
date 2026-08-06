import { useEffect, useState } from 'react'
import { invoke, isTauri } from '../lib/ipc'
import { useAuth } from '../stores/auth'
import PasswordInput from './PasswordInput'
import { toast } from 'sonner'

interface ConfigView {
  admin: { email: string } | null
  no_auth: { value: boolean; source: string }
  session_ttl_hours: { value: number; source: string }
  boot: { port: string; data_dir: string; www_dir: string }
}

/** System settings — account + runtime config overrides.
 *  Precedence: env var > /data/config.json (written here) > default.
 *  Values sourced from env are read-only (badge shows "env"). */
export default function SystemSettings() {
  const { logout } = useAuth()
  const [cfg, setCfg] = useState<ConfigView | null>(null)
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [pwMsg, setPwMsg] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    invoke<string>('config_get').then(s => setCfg(JSON.parse(s))).catch(() => {})
  }, [])

  const changePw = async (e: React.FormEvent) => {
    e.preventDefault()
    setPwMsg('')
    if (newPw.length < 8) { setPwMsg('Password must be at least 8 characters'); return }
    if (newPw !== confirmPw) { setPwMsg('Passwords do not match'); return }
    setBusy(true)
    try {
      await invoke('change_password', { old: oldPw, new: newPw })
      setOldPw(''); setNewPw(''); setConfirmPw('')
      setPwMsg('✓ Password updated')
    } catch (e) { setPwMsg(String(e)) } finally { setBusy(false) }
  }

  const setConfig = async (key: string, value: unknown) => {
    try {
      await invoke('config_set', { key, value })
      setCfg(JSON.parse(await invoke<string>('config_get')))
      toast.success('Saved')
    } catch (e) { toast.error(String(e)) }
  }

  const label = 'text-xs font-medium text-foreground mb-1.5 block'
  const input = 'w-full bg-background border border-border rounded-md px-3 py-2 text-[13px] text-foreground outline-none focus:border-accent'
  const badge = (src: string) => src === 'env'
    ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30 ml-2">from env</span>
    : <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 ml-2">from config</span>

  if (isTauri) return null // web-only: desktop has no account/server-config
  if (!cfg) return <div className="text-xs text-muted">Loading…</div>

  return (
    <div className="flex flex-col gap-5">
      {/* Account */}
      <div>
        <div className="text-xs font-semibold text-foreground mb-2 uppercase tracking-wide">Account</div>
        {cfg.admin ? (
          <>
            <div className="text-xs text-muted mb-3">Signed in as <span className="text-foreground">{cfg.admin.email}</span></div>
            <form onSubmit={changePw} className="flex flex-col gap-2">
              <div>
                <label className={label}>Current password</label>
                <PasswordInput value={oldPw} onChange={setOldPw} className={input} />
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className={label}>New password</label>
                  <PasswordInput value={newPw} onChange={setNewPw} className={input} />
                </div>
                <div className="flex-1">
                  <label className={label}>Confirm</label>
                  <PasswordInput value={confirmPw} onChange={setConfirmPw} className={input} />
                </div>
              </div>
              {pwMsg && <div className="text-xs text-muted">{pwMsg}</div>}
              <div className="flex gap-2">
                <button disabled={busy} className="px-3 py-1.5 text-xs rounded cursor-pointer bg-surface-active text-foreground border-none hover:bg-surface-hover">Update password</button>
                <button onClick={async () => { await logout() }} className="px-3 py-1.5 text-xs rounded cursor-pointer bg-transparent text-danger border border-danger">Sign out</button>
              </div>
            </form>
          </>
        ) : (
          <div className="text-xs text-muted">
            No admin account yet — create one to enable login.
            <button onClick={() => useAuth.getState().refresh()} className="block mt-2 px-3 py-1.5 text-xs rounded cursor-pointer bg-surface-active text-foreground border-none hover:bg-surface-hover">Open setup wizard</button>
          </div>
        )}
      </div>

      {/* Runtime config overrides */}
      <div>
        <div className="text-xs font-semibold text-foreground mb-2 uppercase tracking-wide">Config</div>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-foreground">Require login</div>
              <div className="text-[10px] text-muted">When off, anyone with the URL can use the server (old behavior).{cfg.no_auth.source === 'env' ? ' Controlled by DB_NO_AUTH env var.' : ''}</div>
            </div>
            {cfg.no_auth.source === 'env' ? badge('env') : (
              <button
                onClick={() => setConfig('no_auth', !cfg.no_auth.value)}
                className={'relative w-9 h-5 rounded-full transition-colors cursor-pointer border-none ' + (cfg.no_auth.value ? 'bg-amber-500/60' : 'bg-surface-active')}>
                <span className={'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ' + (cfg.no_auth.value ? 'left-[18px]' : 'left-0.5')} />
              </button>
            )}
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-foreground">Session lifetime</div>
              <div className="text-[10px] text-muted">Hours before re-login is required</div>
            </div>
            {cfg.session_ttl_hours.source === 'env' ? badge('env') : (
              <input
                type="number" min={1} max={8760} value={cfg.session_ttl_hours.value}
                onChange={e => setConfig('session_ttl_hours', Number(e.target.value))}
                className="w-20 bg-background border border-border rounded-md px-2 py-1 text-xs text-foreground outline-none focus:border-accent" />
            )}
          </div>
        </div>
      </div>

      {/* Boot-time env (read-only) */}
      <div>
        <div className="text-xs font-semibold text-foreground mb-2 uppercase tracking-wide">Server (boot-time env)</div>
        <div className="flex flex-col gap-1 text-[11px] text-muted font-mono">
          <div>PORT = {cfg.boot.port}</div>
          <div>DATA_DIR = {cfg.boot.data_dir}</div>
          <div>WWW_DIR = {cfg.boot.www_dir}</div>
        </div>
        <div className="text-[10px] text-muted mt-2">Boot-time values come from environment variables and cannot change at runtime. UI overrides above are persisted to config.json.</div>
      </div>
    </div>
  )
}
