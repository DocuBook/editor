/** Welcome screen shown when no vault is open — launchpad (Open Folder / Create Vault / Recent). */
import { useState } from 'react'
import { Folder, GitBranch, Command, Loader } from 'lucide-react'
import { useVaultStore } from '../../stores/vault'
import { openDir } from '../../lib/ipc'
import { VaultOpenOverlay } from './VaultOpenOverlay'

/** Best-effort display name for the in-flight open: last path segment, or the
 *  repo name when the target is a clone URL. Falls back to undefined so the
 *  overlay keeps its generic "a vault" copy. */
function openLabel(target: string): string | undefined {
  const cleaned = target.replace(/[?#].*$/, '').replace(/\.git$/, '').replace(/\/+$/, '')
  return cleaned.split(/[/\\]/).filter(Boolean).pop() || undefined
}

export function WelcomeScreen() {
  const { recent, openRecent, openVault, createVault, cloneVault, loading, openingPath, openingAt } = useVaultStore()
  const [step, setStep] = useState<'idle' | 'name' | 'clone'>('idle')
  const [parent, setParent] = useState('')
  const [name, setName] = useState('My Vault')
  const [repoUrl, setRepoUrl] = useState('')
  const [cloneErr, setCloneErr] = useState('')

  const pickParent = async (title: string) => {
    const p = await openDir({ title, defaultPath: recent[0]?.parent })
    if (!p) return
    setParent(p)
  }
  const create = () => { if (name.trim()) createVault(parent, name.trim()) }
  const pickCreateParent = async () => { await pickParent('Create Vault'); setStep('name') }
  const pickCloneParent = async () => { await pickParent('Clone Repository'); setCloneErr(''); setRepoUrl(''); setStep('clone') }
  const clone = async () => {
    if (!repoUrl.trim() || !parent) return
    setCloneErr('')
    try { await cloneVault(repoUrl.trim(), parent) }
    catch (e) { setCloneErr(String(e)) }
  }

  const btn = 'w-full flex items-center gap-2 rounded-md px-4 py-2.5 text-sm disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors'
  const btnPrimary = btn + ' justify-center bg-surface-active text-foreground border-none hover:bg-surface-hover'
  const btnSecondary = btn + ' justify-center bg-transparent text-foreground-secondary border border-border hover:bg-surface-active'

  /* An open is in flight. The welcome screen is otherwise only correct at rest:
   * while a vault opens, `isOpen` is still false, so Editor keeps rendering this
   * launchpad and the click looks like a no-op on a large vault. Show the overlay
   * instead of an inert screen.
   *
   * The overlay covers the backend open round-trip only — the store clears it as
   * soon as the vault is open, while the sidebar tree may still be loading behind
   * it. That is deliberate: the editor is already usable at that point. */
  if (openingPath) {
    const rec = recent.find(r => r.path === openingPath)
    return <div className="flex-1 flex items-center justify-center p-8">
      <VaultOpenOverlay name={rec?.name || openLabel(openingPath)} startedAt={openingAt} />
    </div>
  }

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="w-full max-w-[384px] text-center">
        <div className="text-xl font-semibold text-foreground">DocuBook Editor</div>
        <div className="text-xs text-muted mt-1 mb-8 leading-relaxed">
          Pocket notes sync all devices. Start phone, continue desktop. Switch devices anytime, no loss. Realtime collaboration enabled. WYSIWYG rich text editor included. Slash command / like Notion.
        </div>
        <div className="flex flex-col gap-2">
          <button disabled={loading} onClick={openVault} className={btnPrimary}>
            Open Folder <span className="ml-auto text-[11px] text-muted flex items-center gap-0.5"><Command size={11} />O</span>
          </button>
          <button disabled={loading} onClick={pickCreateParent} className={btnSecondary}>
            Create New Vault
          </button>
          <button disabled={loading} onClick={pickCloneParent} className={btnSecondary}>
            Clone Repository <GitBranch size={13} className="text-muted" />
          </button>
        </div>
        {recent.length > 0 && (
          <div className="mt-6">
            <div className="text-[10px] uppercase tracking-[1px] text-muted mb-1.5">Recent Vaults</div>
            <div className="flex flex-col gap-1">
              {recent.map(r => (
                <button key={r.path} disabled={loading} onClick={() => openRecent(r.path)}
                  className={btn + ' justify-start px-3 py-2 bg-transparent text-foreground-secondary border border-border hover:bg-surface-active'}>
                  <Folder size={14} className="text-muted shrink-0" />
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap text-foreground font-medium">{r.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {step === 'name' && (
          <div className="mt-4 text-left">
            <input autoFocus type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Vault name"
              onKeyDown={e => { if (e.key === 'Enter') create(); if (e.key === 'Escape') { setStep('idle'); setName('My Vault') } }}
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground outline-none" />
            <div className="text-[10px] text-muted mt-1 truncate">Created in {parent}</div>
          </div>
        )}
        {step === 'clone' && (
          <div className="mt-4 text-left">
            <input autoFocus type="text" value={repoUrl} onChange={e => { setRepoUrl(e.target.value); setCloneErr('') }} placeholder="https://github.com/user/repo.git"
              onKeyDown={e => { if (e.key === 'Enter') clone(); if (e.key === 'Escape') { setStep('idle'); setCloneErr('') } }}
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground outline-none" />
            <div className="flex items-center gap-2 mt-2">
              <button disabled={loading || !repoUrl.trim()} onClick={clone} className={btnPrimary + ' !w-auto px-4'}>
                {loading ? <><Loader size={13} className="animate-spin" /> Cloning…</> : 'Clone'}
              </button>
              <button onClick={() => { setStep('idle'); setCloneErr('') }} className="text-xs text-muted hover:text-foreground-secondary cursor-pointer bg-transparent border-none">Cancel</button>
            </div>
            {cloneErr && <div className="mt-2 text-[11px] text-danger leading-relaxed">Clone failed: {cloneErr}</div>}
            <div className="text-[10px] text-muted mt-2 leading-relaxed">
              Clone into {parent}. Private repos need your SSH key or git credential helper (macOS Keychain) already configured on this machine — the app uses them automatically. Public repos need no setup.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
