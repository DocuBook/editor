import { useEffect, useState } from 'react'
import { invoke } from '../lib/ipc'
import { Folder, Loader, X } from 'lucide-react'

interface ServerVault { name: string; path: string }

/** Web-only vault picker (replaces the native folder dialog, which browsers
 *  don't have). The server owns the filesystem, so this lists vaults under
 *  DATA_DIR/vaults: click to open, type a name to create, or use the vaults
 *  folder as parent (create/clone flows). Returns the chosen path or null on
 *  cancel — same contract as the native dialog, so callers are unchanged. */
export default function VaultPicker({ onPick }: { onPick: (path: string | null) => void }) {
  const [vaults, setVaults] = useState<ServerVault[]>([])
  const [rootPath, setRootPath] = useState('')
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const [r, list] = await Promise.all([
          invoke<string>('web_vault_root'),
          invoke<string>('web_vaults').catch(() => '[]'),
        ])
        setRootPath(r.trim())
        setVaults(JSON.parse(list))
      } catch { /* keep empty state */ } finally { setLoading(false) }
    })()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onPick(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onPick])

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (!n || !rootPath) return
    setCreating(true); setErr('')
    try {
      await invoke('create_vault', { parent: rootPath, name: n })
      onPick(`${rootPath}/${n}`)
    } catch (e2) { setErr(String(e2)); setCreating(false) }
  }

  const item = 'w-full flex items-center gap-2 px-3 py-2 rounded-md text-[13px] cursor-pointer bg-transparent border-none text-left transition-colors'

  return (
    <div className="fixed inset-0 flex items-start justify-center pt-[20vh] bg-black/40" onClick={() => onPick(null)}>
      <div className="w-[360px] bg-surface border border-border rounded-xl shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)] overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <h2 className="text-[13px] font-semibold text-foreground">Open Vault</h2>
          <button onClick={() => onPick(null)} className="p-1 rounded cursor-pointer bg-transparent text-muted border-none hover:text-foreground-secondary"><X size={15} /></button>
        </div>

        <div className="p-3">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted"><Loader size={14} className="animate-spin" /> Loading vaults…</div>
          ) : vaults.length === 0 ? (
            <div className="py-4 px-3 text-xs text-muted text-center">No vaults on the server yet</div>
          ) : (
            <div className="max-h-[240px] overflow-y-auto flex flex-col gap-0.5 mb-3">
              {vaults.map(v => (
                <button key={v.path} onClick={() => onPick(v.path)} className={item + ' text-foreground-secondary hover:bg-surface-active hover:text-foreground'}>
                  <Folder size={14} className="shrink-0 text-muted" />
                  <span className="flex-1 truncate">{v.name}</span>
                </button>
              ))}
            </div>
          )}

          <form onSubmit={create} className="flex gap-2">
            <input
              value={name} onChange={e => setName(e.target.value)} placeholder="New vault name"
              className="flex-1 min-w-0 bg-background border border-border rounded-md px-3 py-2 text-[13px] text-foreground outline-none focus:border-accent"
            />
            <button disabled={creating || !name.trim()} className="px-3 py-2 text-xs rounded-md cursor-pointer bg-surface-active text-foreground border-none hover:bg-surface-hover disabled:opacity-40">
              {creating ? 'Creating…' : 'Create'}
            </button>
          </form>
          {err && <div className="text-[11px] text-red-400 mt-2">{err}</div>}

          {rootPath && (
            <button onClick={() => onPick(rootPath)} className="mt-3 w-full text-center text-[11px] text-muted hover:text-foreground-secondary cursor-pointer bg-transparent border-none">
              Use {rootPath} as parent folder (create / clone here)
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
