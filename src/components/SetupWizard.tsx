import { useEffect, useState } from 'react'
import { invoke } from '../lib/ipc'
import { useAuth } from '../stores/auth'
import { toast } from 'sonner'

/** First-run wizard — create the admin account (first user becomes the
 *  admin). Backward compat: "Skip" keeps open access (no_auth)
 *  exactly like pre-web deployments; login can be enabled later in Settings.
 *  Shows the setup-token field only when the server requires one
 *  (DB_SETUP_TOKEN set — plain secret string, not a JWT). */
export default function SetupWizard() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [token, setToken] = useState('')
  const [tokenRequired, setTokenRequired] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    invoke<string>('setup_status')
      .then(s => { try { setTokenRequired(!!JSON.parse(s).setupToken) } catch { /* keep hidden */ } })
      .catch(() => {})
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr('')
    if (!email.includes('@')) { setErr('Enter a valid email'); return }
    if (password.length < 8) { setErr('Password must be at least 8 characters'); return }
    if (password !== confirm) { setErr('Passwords do not match'); return }
    if (tokenRequired && !token.trim()) { setErr('Setup token is required — check the server env (DB_SETUP_TOKEN)'); return }
    setBusy(true)
    try {
      await invoke('setup_admin', { email, password, ...(tokenRequired ? { token: token.trim() } : {}) })
      await useAuth.getState().refresh()
    } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }

  const skip = async () => {
    setBusy(true)
    try {
      await invoke('config_set', { key: 'no_auth', value: true })
      await useAuth.getState().refresh()
    } catch (e) { toast.error(String(e)); setBusy(false) }
  }

  const input = 'w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-md px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]'
  const btn = 'w-full flex items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm cursor-pointer transition-colors disabled:opacity-40'

  return (
    <div className="h-screen flex items-center justify-center p-8">
      <div className="w-full max-w-[360px]">
        <div className="text-xl font-semibold text-[var(--text-primary)] text-center">DocuBook</div>
        <div className="text-xs text-[var(--text-muted)] mt-1 mb-8 text-center leading-relaxed">
          Welcome! Create the admin account to secure this server.<br />
          One account — this is a personal vault server.
        </div>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" className={input} autoFocus />
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password (min 8 chars)" className={input} />
          <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="Confirm password" className={input} />
          {tokenRequired && (
            <input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="Setup token (DB_SETUP_TOKEN)" className={input} />
          )}
          {err && <div className="text-xs text-red-400">{err}</div>}
          <button disabled={busy} className={btn + ' bg-[var(--bg-hover)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'}>
            {busy ? 'Creating…' : 'Create admin account'}
          </button>
        </form>
        <button disabled={busy} onClick={skip} className="w-full text-center text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] cursor-pointer bg-transparent border-none mt-4">
          Skip for now — keep open access (enable login later in Settings)
        </button>
      </div>
    </div>
  )
}
