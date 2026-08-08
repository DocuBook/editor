import { useState } from 'react'
import { invoke } from '../lib/ipc'
import { useAuth } from '../stores/auth'
import PasswordInput from './PasswordInput'

/** Login gate — session cookie is httpOnly (never visible to JS), set by the
 *  server on success. Wrong credentials are rate-limited (5 tries / minute). */
export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr('')
    setBusy(true)
    try {
      await invoke('login', { email, password })
      await useAuth.getState().refresh()
    } catch (e) {
      setErr(String(e))
      setPassword('')
    } finally { setBusy(false) }
  }

  const input = 'w-full bg-background border border-border rounded-md px-3 py-2 text-[13px] text-foreground outline-none focus:border-accent'

  return (
    <div className="h-screen flex items-center justify-center p-8">
      <div className="w-full max-w-[320px]">
        <div className="text-xl font-semibold text-foreground text-center">DocuBook</div>
        <div className="text-xs text-muted mt-1 mb-8 text-center">Sign in to your vault server</div>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" className={input} autoFocus />
          <PasswordInput value={password} onChange={setPassword} placeholder="Password" className={input} />
          {err && <div className="text-xs text-red-400">{err}</div>}
          <button disabled={busy} className="w-full flex items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm cursor-pointer bg-accent hover:bg-accent-hover text-white disabled:opacity-40">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
