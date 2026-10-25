import { useEffect, useState } from 'react'
import { Info } from 'lucide-react'
import { invoke } from '../lib/ipc'
import { useAuth } from '../stores/auth'
import { buildSetupPayload, setupTokenHint, validateSetupInput, type SetupTokenSource } from '../utils/setupWizard'
import { isPasswordValid } from '../utils/passwordPolicy'
import PasswordInput from './PasswordInput'
import PasswordRequirements from './PasswordRequirements'

/** First-run wizard — creates the admin account. A setup token is always
 *  required: DB_SETUP_TOKEN when set, otherwise the one-time token the server
 *  prints to its log at boot. It is a plain secret string (not a JWT). */
export default function SetupWizard() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [token, setToken] = useState('')
  const [tokenRequired, setTokenRequired] = useState(false)
  const [tokenSource, setTokenSource] = useState<SetupTokenSource>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    invoke<string>('setup_status')
      .then(s => {
        try {
          const status = JSON.parse(s)
          setTokenRequired(!!status.setupToken)
          setTokenSource(status.setupTokenSource ?? null)
        } catch { /* keep hidden */ }
      })
      .catch(() => {})
  }, [])

  const hint = setupTokenHint(tokenSource)

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


  const input = 'w-full bg-background border border-border rounded-md px-3 py-2 text-[13px] text-foreground outline-none focus:border-accent'
  const btn = 'w-full flex items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm cursor-pointer transition-colors disabled:opacity-40'

  const passwordValid = isPasswordValid(password)
  const confirmMatches = confirm.length > 0 && confirm === password
  const canSubmit = !busy
    && email.trim().includes('@')
    && passwordValid
    && confirmMatches
    && (!tokenRequired || token.trim().length > 0)

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
          <div>
            <PasswordInput value={password} onChange={setPassword} placeholder="Password" className={input} />
            <PasswordRequirements password={password} />
          </div>
          <div>
            <PasswordInput value={confirm} onChange={setConfirm} placeholder="Confirm password" className={input} />
            {confirm.length > 0 && confirm !== password && (
              <div className="text-xs text-danger mt-1">Passwords do not match</div>
            )}
          </div>
          {tokenRequired && (
            <div>
              <input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="Setup token" aria-describedby="setup-token-hint" className={input} />
              {hint && (
                <div id="setup-token-hint" role="note" className="mt-2 flex gap-2.5 rounded-md border border-border-subtle bg-accent-subtle px-3 py-2.5">
                  <Info size={15} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                  <div className="min-w-0 text-xs text-foreground-secondary">
                    <div className="font-semibold text-foreground">{hint.title}</div>
                    <div className="mt-0.5">{hint.body}</div>
                    {hint.code && (
                      <code className="mt-1.5 block overflow-x-auto rounded bg-background px-2 py-1 font-mono text-[11px] text-foreground">{hint.code}</code>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          {err && <div className="text-xs text-danger">{err}</div>}
          <button disabled={!canSubmit} className={btn + ' bg-accent hover:bg-accent-hover text-on-accent'}>
            {busy ? 'Creating…' : 'Create admin account'}
          </button>
        </form>
      </div>
    </div>
  )
}
