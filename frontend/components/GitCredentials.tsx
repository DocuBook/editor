import { useEffect, useState } from 'react'
import { KeyRound, X } from 'lucide-react'
import { toast } from 'sonner'
import { invoke, isTauri } from '../lib/ipc'
import SettingsSection from './settings/SettingsSection'

interface StoredCredential { host: string; username: string }
interface CredentialList { encryption: boolean; credentials: StoredCredential[]; error: string }

const inputCls = 'w-full bg-background border border-border rounded-md px-3 py-1.5 text-xs text-foreground outline-none font-mono focus:border-accent'
const btnPrimary = 'px-3 py-1.5 rounded-md bg-accent text-on-accent border-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed text-xs whitespace-nowrap hover:bg-accent-hover transition-colors'

/** How remotes authenticate. The desktop app borrows the machine's own Git setup;
 *  the web server (a container with no helper, agent or `~/.ssh`) keeps HTTPS
 *  access tokens in an encrypted store. A saved token never comes back to the
 *  browser — the list only names hosts and usernames. */
export default function GitCredentials() {
  return (
    <SettingsSection id="git-credentials" title="Credentials">
      {isTauri ? <DesktopGuidance /> : <TokenStore />}
    </SettingsSection>
  )
}

function DesktopGuidance() {
  return (
    <div className="text-[11px] text-muted leading-relaxed flex flex-col gap-1.5">
      <div>
        The app uses this machine's Git credentials. Public repositories need none; pushing, and any private repository, do.
      </div>
      <div>
        <span className="text-foreground-secondary">HTTPS</span> — a credential helper set in your <span className="font-mono">global</span> config,
        e.g. <span className="font-mono">git config --global credential.helper osxkeychain</span>. A helper that only Xcode's or Homebrew's
        own Git config sets is not picked up.
      </div>
      <div>
        <span className="text-foreground-secondary">SSH</span> — a key loaded in <span className="font-mono">ssh-agent</span> (passphrase-protected keys
        must be added there), or an unencrypted <span className="font-mono">~/.ssh/id_ed25519</span>; the host must be in <span className="font-mono">~/.ssh/known_hosts</span>.
      </div>
    </div>
  )
}

function TokenStore() {
  const [state, setState] = useState<CredentialList | null>(null)
  const [host, setHost] = useState('github.com')
  const [username, setUsername] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const load = async () => {
    try {
      const d = JSON.parse(await invoke<string>('git_credentials'))
      setState({
        encryption: d.encryption === true,
        credentials: Array.isArray(d.credentials) ? d.credentials : [],
        error: typeof d.error === 'string' ? d.error : '',
      })
    } catch (e) { setErr(String(e)) }
  }
  /* oxlint-disable react/set-state-in-effect -- initial async load */
  useEffect(() => { void load() }, [])
  /* oxlint-enable react/set-state-in-effect */

  const save = async () => {
    setBusy(true); setErr('')
    try {
      const saved = JSON.parse(await invoke<string>('git_set_credential', { host, username, token })) as { host: string }
      // The token is not kept in the page once the server has it.
      setToken('')
      toast.success(`Access token saved for ${saved.host}`)
      await load()
    } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }

  const remove = async (entry: StoredCredential) => {
    setBusy(true); setErr('')
    try {
      await invoke('git_delete_credential', { host: entry.host })
      toast.success(`Access token removed for ${entry.host}`)
      await load()
    } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }

  if (!state) return <div className="text-muted py-2">{err ? <span className="text-danger">{err}</span> : 'Loading credentials…'}</div>

  const locked = !state.encryption || !!state.error
  return (
    <div className="text-xs">
      <div className="text-[11px] text-muted leading-relaxed mb-2">
        Pushing, and any private repository, need an access token for an <span className="font-mono">https://</span> remote. Tokens are stored
        encrypted in the data volume and are never shown again. SSH remotes are not supported here.
      </div>
      {!state.encryption && (
        <div role="alert" className="text-[11px] text-warning leading-relaxed mb-2">
          Encryption is not configured. Set the <span className="font-mono">DB_KEYS_PASSPHRASE</span> environment variable and restart the
          server — tokens are only ever saved encrypted.
        </div>
      )}
      {state.error && <div role="alert" className="text-[11px] text-danger mb-2">{state.error}</div>}

      {state.credentials.map(entry => (
        <div key={entry.host} className="flex items-center gap-2 py-1 border-b border-border-subtle last:border-none">
          <KeyRound size={12} className="shrink-0 text-foreground-subtle" />
          <span className="font-mono text-foreground">{entry.host}</span>
          <span className="text-muted truncate">{entry.username}</span>
          <button onClick={() => void remove(entry)} disabled={busy} aria-label={'Remove token for ' + entry.host}
            className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md bg-transparent text-foreground-subtle border border-border cursor-pointer hover:text-danger hover:border-danger disabled:opacity-40 disabled:cursor-not-allowed transition-colors"><X size={12} /></button>
        </div>
      ))}

      <div className="flex gap-2 mt-2">
        <input value={host} onChange={e => setHost(e.target.value)} placeholder="github.com" aria-label="Host" disabled={locked} className={inputCls + ' w-36!'} />
        <input value={username} onChange={e => setUsername(e.target.value)} placeholder="Username" aria-label="Username" autoComplete="off" disabled={locked} className={inputCls + ' w-32!'} />
        <input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="Access token" aria-label="Access token" autoComplete="new-password" disabled={locked} className={inputCls} />
        <button onClick={() => void save()} disabled={locked || busy || !host.trim() || !username.trim() || !token.trim()} className={'shrink-0 ' + btnPrimary}>{busy ? '…' : 'Save'}</button>
      </div>
      <div className="text-[10px] text-muted mt-1.5 leading-relaxed">
        Use a token scoped to the vault's repository only — e.g. a GitHub fine-grained token with <span className="font-mono">Contents: read and write</span>,
        or a GitLab project access token with <span className="font-mono">write_repository</span>. Anyone who can sign in here can push with it.
        Saving again for the same host replaces its token.
      </div>
      {err && <div className="text-[11px] text-danger mt-2">{err}</div>}
    </div>
  )
}
