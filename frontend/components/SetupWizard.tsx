import { useEffect, useState } from 'react'
import { invoke } from '../lib/ipc'
import { useAuth } from '../stores/auth'
import { buildSetupPayload, validateSetupInput } from '../utils/setupWizard'
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
    const err = validateSetupInput({ email, password, confirm, token, tokenRequired })
    if (err) { setErr(err); return }
    setBusy(true)
    try {
      await invoke('setup_admin', buildSetupPayload(email, password, token, tokenRequired))
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

  /** Explicit consent gate: "keep open access" means anyone with the URL can
   *  use this server — the skip button stays disabled until acknowledged. */
  const [ackOpen, setAckOpen] = useState(false)

  const input = 'w-full bg-background border border-border rounded-md px-3 py-2 text-[13px] text-foreground outline-none focus:border-accent'
  const btn = 'w-full flex items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm cursor-pointer transition-colors disabled:opacity-40'

  return (
    <div className="h-screen flex items-center justify-center p-8">
      <div className="w-full max-w-[360px]">
        <div className="text-xl font-semibold text-foreground text-center">DocuBook Editor</div>
        <div className="text-xs text-muted mt-1 mb-8 text-center leading-relaxed">
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
          <button disabled={busy} className={btn + ' bg-accent hover:bg-accent-hover text-white'}>
            {busy ? 'Creating…' : 'Create admin account'}
          </button>
        </form>
        <label className="flex items-start gap-2 mt-4 text-[11px] text-muted cursor-pointer select-none">
          <input type="checkbox" checked={ackOpen} onChange={e => setAckOpen(e.target.checked)}
            className="mt-0.5 cursor-pointer accent-amber-500" />
          <span>I understand that <span className="text-foreground-secondary">anyone with this URL</span> can access and modify all vaults without logging in. I will enable login later in Settings.</span>
        </label>
        <button disabled={busy || !ackOpen} onClick={skip} className="w-full text-center text-[11px] text-muted hover:text-foreground-secondary cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 bg-transparent border-none mt-2">
          Skip for now — keep open access (enable login later in Settings)
        </button>
      </div>
    </div>
  )
}
