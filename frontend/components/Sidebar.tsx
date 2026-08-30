import { useState, useEffect, useRef, useCallback } from 'react'
import { useVaultStore } from '../stores/vault'
import { useEditorStore } from '../stores/editor'
import { invoke, isTauri } from '../lib/ipc'
import { Search, Check, ChevronDown, Folder, FileText, FolderOpen, Plus, X, Command, Settings, Option, Trash, RotateCcw, ArrowBigUp } from 'lucide-react'
import { toast } from 'sonner'
import { useClickOutside } from '../hooks/useClickOutside'
import { useKeyboard } from '../hooks/useKeyboard'
import { MARKDOWN_EXTENSIONS, stripMarkdownExt } from '../utils/fileKind'

/** Panel showing backlinks for the currently active file. */
function BacklinksPanel() {
  const [items, setItems] = useState<{path:string;name:string;snippet:string}[]>([])
  const { openFile } = useEditorStore()
  const activeTab = useEditorStore(s => s.activeTab)

  useEffect(() => {
    if (!activeTab) { setItems([]); return }
    invoke<string>('wiki_backlinks', { path: activeTab }).then(s => { try { setItems(JSON.parse(s)) } catch(e) { console.error('Backlinks parse:', e); setItems([]) } }).catch(e => console.error('Backlinks:', e))
  }, [activeTab])

  if (items.length === 0) return null
  return (
    <div className="p-2">
      <div className="text-zinc-600 uppercase tracking-wider mb-1 px-1">Backlinks ({items.length})</div>
      {items.map(item => (
        <div key={item.path} onClick={() => openFile(item.path, item.name)}
          className="text-zinc-500 hover:text-foreground-secondary cursor-pointer py-1 px-1 rounded hover:bg-surface-active">
          <div className="truncate">{item.name}</div>
          {item.snippet && <div className="truncate text-[10px] text-zinc-600">{item.snippet}</div>}
        </div>
      ))}
    </div>
  )
}

export default function Sidebar({ onOpenSettings, onOpenSearch, registerSearchFolder }: { onOpenSettings: () => void; onOpenSearch: () => void; registerSearchFolder: (fn: (path: string) => void) => void }) {
  const [creating, setCreating] = useState<'file'|'folder'|null>(null)
  const [showPlusMenu, setShowPlusMenu] = useState(false)
  const [newName, setNewName] = useState('')
  const newInputRef = useRef<HTMLInputElement>(null)
  const createBusyRef = useRef(false)
  const plusMenuRef = useRef<HTMLSpanElement>(null)
  const ctxMenuRef = useRef<HTMLDivElement>(null)
  const vaultMenuRef = useRef<HTMLSpanElement>(null)
  const [vaultMenuOpen, setVaultMenuOpen] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)

  useEffect(() => {
    if (creating) setTimeout(() => newInputRef.current?.focus(), 50)
  }, [creating])

  const closeContextMenu = () => setCtxItem(null)

  // Close popups / menus on click outside
  useClickOutside(plusMenuRef, () => setShowPlusMenu(false))
  useClickOutside(newInputRef, () => { if (creating) { setCreating(null); setNewName('') } })
  useClickOutside(ctxMenuRef, closeContextMenu)
  useClickOutside(vaultMenuRef, () => setVaultMenuOpen(false))

  const handleCreate = async () => {
    if (!newName.trim() || !isOpen || loading || !creating || createBusyRef.current) return
    createBusyRef.current = true
    const targetVaultPath = vaultPath
    try {
      let name = newName.trim()
      if (creating === 'file' && !/\.\w{1,10}$/i.test(name)) name = name + '.md'
      const fullPath = currentFolder ? (name.startsWith(currentFolder + '/') ? name : currentFolder + '/' + name) : name
      if (creating === 'folder') {
        await invoke('create_directory', { path: fullPath })
      } else {
        const p = await invoke<string>('create_file', { path: fullPath })
        openFile(p, name)
      }
      if (useVaultStore.getState().vaultPath !== targetVaultPath || !useVaultStore.getState().isOpen) return
      await loadTree()
      setNewName('')
      setCreating(null)
    } catch(e) { console.error(e); toast.error('Failed to create') }
    finally { createBusyRef.current = false }
  }
  const { name, isOpen, vaultPath, recent, visibleItems, loading, closeVault, openVault, openRecent, toggleFolder, loadTree } = useVaultStore()
  const { openFile } = useEditorStore()

  // Context menu
  const [ctxItem, setCtxItem] = useState<{path:string;name:string;type:string}|null>(null)
  const [ctxPos, setCtxPos] = useState({x:0,y:0})
  const openContextMenu = (item: any, e: React.MouseEvent) => { setCtxItem(item); setCtxPos({x: e.clientX, y: e.clientY}) }
  const [renaming, setRenaming] = useState<{path:string;name:string;type:string}|null>(null)
  const renameRef = useRef<HTMLInputElement>(null)
  const [currentFolder, setCurrentFolder] = useState('')
  /** Keep the modal's onSelect wired to the sidebar's create-target folder:
   *  search is owned by App (works with the sidebar closed), which calls this
   *  callback only while the sidebar is mounted. */
  useEffect(() => { registerSearchFolder(setCurrentFolder) }, [registerSearchFolder, setCurrentFolder])
  useEffect(() => {
    setCurrentFolder('')
    setCreating(null)
    setNewName('')
  }, [vaultPath, isOpen])
  /** Server-side trash (web only — native uses the system Trash/Finder). */
  const [trashOpen, setTrashOpen] = useState(false)
  const [trashItems, setTrashItems] = useState<{name:string;original:string;deleted_at:number}[]>([])
  const loadTrash = useCallback(async () => {
    try {
      // web invoke returns the JSON as a string (must parse); desktop returns
      // the parsed array — normalize both, never let a non-array reach .map
      const raw = await invoke<string>('list_trash')
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      setTrashItems(Array.isArray(parsed) ? parsed : [])
    } catch(e) { console.error(e); setTrashItems([]) }
  }, [])
  const toggleTrash = async () => { if (trashOpen) { setTrashOpen(false); return } await loadTrash(); setTrashOpen(true) }
  const restoreItem = async (item: {name:string;original:string;deleted_at:number}) => {
    try { await invoke('restore_file', { trashName: item.name }); toast.success('Restored ' + item.original); await loadTrash(); await loadTree() } catch(e) { console.error(e); toast.error('Restore failed') }
  }
  const emptyTrash = async () => {
    try { await invoke('empty_trash'); setTrashItems([]); await loadTree() } catch(e) { console.error(e); toast.error('Failed to empty trash') }
  }

  useEffect(() => {
    if (renaming) setTimeout(() => renameRef.current?.focus(), 50)
  }, [renaming])

  // Keyboard shortcuts
  useKeyboard((e: KeyboardEvent) => {
    if (e.key === 'Escape') { setShowPlusMenu(false); setVaultMenuOpen(false); setConfirmClose(false) }
    /** New file/folder. Canonical (all platforms): ⌘⇧F / ⌘⌥⇧F — browsers
     *  reserve ⌘N / ⌘⇧N / ⌘⌥N (new window / private window) and never deliver
     *  them to the page, so web only ever sees the canonical mapping. Native
     *  keeps ⌘N / ⌘⌥N as a bonus alias for the same actions. */
    const mod = e.metaKey || e.ctrlKey
    const newFile = (mod && e.shiftKey && !e.altKey && e.code === 'KeyF') || (mod && !e.shiftKey && !e.altKey && e.code === 'KeyN')
    const newFolder = (mod && e.shiftKey && e.altKey && e.code === 'KeyF') || (mod && !e.shiftKey && e.altKey && e.code === 'KeyN')
    if (newFile) {
      e.preventDefault()
      if (!isOpen || loading) { toast.error('Open a vault first — press ⌘O'); return }
      setCreating('file'); setNewName('')
    }
    if (newFolder) {
      e.preventDefault()
      if (!isOpen || loading) { toast.error('Open a vault first — press ⌘O'); return }
      setCreating('folder'); setNewName('')
    }
  })

  // Refresh tree on window focus
  useEffect(() => {
    if (!isOpen || isTauri) return
    // Read the actual trash contents so the Trash button reflects real state.
    loadTrash()
    const h = () => loadTree()
    window.addEventListener('focus', h)
    return () => window.removeEventListener('focus', h)
  }, [isOpen, loadTree, loadTrash])

  /** Shared header icon style - theme tokens only, so +/search/X match in both themes. */
  const iconBtn = 'cursor-pointer p-1 rounded hover:bg-surface-active text-foreground-subtle hover:text-foreground transition-colors'

  return (
    <aside className="ui-shell w-56 bg-surface border-r border-border-subtle flex flex-col shrink-0 h-full">
      <div className="relative flex items-center justify-between border-b border-border-subtle px-2 py-3">
        <span className="tip-wrap tip-bar relative flex-1 min-w-0" ref={vaultMenuRef}>
          <button onClick={(e) => { setVaultMenuOpen(o => !o); e.currentTarget.blur() }} disabled={loading} aria-label="Switch vault" aria-expanded={vaultMenuOpen}
            className={'flex items-center gap-1 max-w-full cursor-pointer rounded px-1 py-0.5 bg-transparent border-none hover:bg-surface-active transition-colors disabled:opacity-40 disabled:cursor-not-allowed ' + (vaultMenuOpen ? 'text-foreground' : 'text-zinc-500')}>
            <span className="text-xs font-semibold uppercase tracking-wider truncate">{name}</span>
            <ChevronDown size={14} className="shrink-0" />
          </button>
          {vaultMenuOpen && (
            <div data-vault-menu className="absolute top-full left-0 mt-1 bg-surface border border-border rounded-lg p-1 min-w-[220px] z-50 shadow-[0_4px_12px_rgba(0,0,0,0.3)]">
              {recent.length === 0 && <div className="px-2.5 py-1.5 text-[11px] text-foreground-subtle italic">No recent vaults</div>}
              {recent.length > 0 && (
                <div className="max-h-56 overflow-y-auto">
                  {recent.slice(0, 5).map(r => {
                    const active = r.path === vaultPath
                    return (
                      <button key={r.path} onClick={() => { setVaultMenuOpen(false); if (!active) openRecent(r.path) }}
                        className={'flex items-center gap-2 w-full px-2.5 py-1.5 cursor-pointer text-left bg-transparent border-none rounded text-[12px] hover:bg-surface-active ' + (active ? 'text-foreground cursor-default' : 'text-foreground-secondary')}>
                        {active ? <Check size={13} className="text-accent shrink-0" /> : <Folder size={13} className="text-zinc-500 shrink-0" />}
                        <span className="truncate flex-1">{r.name}</span>
                      </button>
                    )
                  })}
                </div>
              )}
              <div className="border-t border-border-subtle my-1" />
              <button onClick={() => { setVaultMenuOpen(false); openVault() }}
                className="flex items-center gap-2 w-full px-2.5 py-1.5 cursor-pointer text-[13px] text-foreground-secondary bg-transparent border-none rounded text-left hover:bg-surface-active">
                <FolderOpen size={14} /> Open Vault
              </button>
              <button onClick={() => { setVaultMenuOpen(false); setConfirmClose(true) }}
                className="flex items-center gap-2 w-full px-2.5 py-1.5 cursor-pointer text-[13px] text-danger bg-transparent border-none rounded text-left hover:bg-surface-active">
                <X size={14} /> Close Vault
              </button>
            </div>
          )}
        </span>
        <span className="flex items-center gap-1 shrink-0 ml-2">
          <span className="tip-wrap tip-bar relative" ref={plusMenuRef}>
            <button onClick={(e) => { setShowPlusMenu(o => !o); e.currentTarget.blur() }} aria-label="Create file or folder" data-plus-btn disabled={loading} className={iconBtn + ' disabled:opacity-30 disabled:cursor-not-allowed'}>
              <Plus size={14} />
            </button>
            <span className="tip">Create a file/folder</span>
            {showPlusMenu && (
              <div data-plus-popup className="absolute top-full left-0 mt-1 bg-surface border border-border rounded-lg p-1 min-w-[180px] z-50 shadow-[0_4px_12px_rgba(0,0,0,0.3)]">
                <button onClick={() => { if (loading) return; setShowPlusMenu(false); setCreating('file'); setNewName('') }}
                  className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer text-[13px] text-foreground-secondary bg-transparent border-none rounded w-full text-left hover:bg-surface-active">
                  <FileText size={14} /> New File
                  <span className="ml-auto text-[10px] text-muted font-mono flex items-center gap-0.5 whitespace-nowrap"><kbd className="inline-flex items-center gap-0.5 bg-background px-1 py-0.5 rounded-[3px] text-[10px]"><Command size={9} />{isTauri ? 'N' : <><ArrowBigUp size={9} />F</>}</kbd></span>
                </button>
                <button onClick={() => { if (loading) return; setShowPlusMenu(false); setCreating('folder'); setNewName('') }}
                  className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer text-[13px] text-foreground-secondary bg-transparent border-none rounded w-full text-left hover:bg-surface-active">
                  <Folder size={14} /> New Folder
                  <span className="ml-auto text-[10px] text-muted font-mono flex items-center gap-0.5 whitespace-nowrap"><kbd className="inline-flex items-center gap-0.5 bg-background px-1 py-0.5 rounded-[3px] text-[10px]"><Option size={9} /><Command size={9} />{isTauri ? 'N' : <><ArrowBigUp size={9} />F</>}</kbd></span>
                </button>
              </div>
            )}
            </span>
          </span>
        </div>

      {/* Inline search trigger (inline component area below the vault header) — the modal itself lives in App so ⌘F/⌘P still work with the sidebar closed. */}
      <div className="px-2 py-2">
        <button onClick={onOpenSearch} aria-label="Search project files" className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md border border-border bg-background text-foreground-subtle hover:text-foreground-secondary cursor-pointer transition-colors text-left">
          <Search size={14} className="text-muted shrink-0" />
          <span className="flex-1 truncate text-[13px]">Search</span>
          <kbd className="inline-flex items-center gap-0.5 bg-surface px-1 py-0.5 rounded-[3px] text-[10px] font-mono text-muted border border-border-subtle"><Command size={9} />F</kbd>
        </button>
      </div>

      {isOpen ? (
        <div className="flex-1 p-2 text-sm overflow-y-auto space-y-0.5">
            {!trashOpen && loading && <div className="text-zinc-500 text-xs p-2">Loading...</div>}
            {!trashOpen && !loading && visibleItems.length === 0 && !creating && <div className="text-zinc-500 italic text-xs p-2">Empty vault</div>}
            {!trashOpen && renaming && (
              <input ref={renameRef} type="text" defaultValue={stripMarkdownExt(renaming.name)}
                className="w-full bg-background text-foreground text-[13px] px-2.5 py-1.5 rounded border border-accent outline-none mb-1"
                onKeyDown={async e => {
                  if (e.key === 'Enter') {
                    const dir = renaming.path.substring(0, renaming.path.lastIndexOf('/') + 1)
                    let target = (e.target as HTMLInputElement).value
                    if (MARKDOWN_EXTENSIONS.some(e => renaming.path.toLowerCase().endsWith(e)) && !/\.\w{1,10}$/i.test(target)) target = target + '.md'
                    const newPath = dir + target
                    try {
                      await invoke('rename_file', { from: renaming.path, to: newPath })
                      useEditorStore.getState().renameTab(renaming.path, newPath)
                      /* Keep the create-here target in sync: create_file re-creates missing
                       * parent dirs, so a stale currentFolder would silently recreate the
                       * old folder (A -> Z then new file lands in A/). */
                      if (renaming.type === '1') setCurrentFolder(prev => {
                        if (!prev) return prev
                        if (prev === renaming.path) return newPath
                        if (prev.startsWith(renaming.path + '/')) return newPath + prev.slice(renaming.path.length)
                        return prev
                      })
                      await loadTree()
                    } catch(err) { console.error(err); toast.error('Failed to rename') }
                    setRenaming(null)
                  }
                  if (e.key === 'Escape') setRenaming(null)
                }} />
            )}
            {!trashOpen && creating && (
              <input ref={newInputRef} type="text" value={newName} onChange={e => setNewName(e.target.value)}
                placeholder={creating === 'file' ? (currentFolder ? 'File in ' + currentFolder + '/' : 'Filename...') : (currentFolder ? 'Folder in ' + currentFolder + '/' : 'Folder name...')}
                className="w-full bg-background text-foreground text-[13px] px-2.5 py-1.5 rounded border border-accent outline-none mb-1"
                onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') { setCreating(null); setNewName('') } }} />
            )}
            {!trashOpen && visibleItems.map(item => (
              <div key={item.path}>
                {item.type === '1' ? (
                  <div onClick={() => { toggleFolder(item); setCurrentFolder(item.path) }} onContextMenu={e => { e.preventDefault(); openContextMenu(item, e) }}
                    className={'depth-' + Math.min(item.depth || 0, 12) + ' flex items-center gap-2 py-1 pr-2 rounded hover:bg-surface-active cursor-pointer ' + (item.isExpanded ? 'text-foreground-secondary' : 'text-foreground-subtle')}>
                    {item.isExpanded ? <FolderOpen size={14} /> : <Folder size={14} />}
                    <span className="truncate">{item.name}</span>
                  </div>
                ) : (
                  <div onClick={() => { openFile(item.path, item.name); setCurrentFolder(item.path.includes('/') ? item.path.substring(0, item.path.lastIndexOf('/')) : '') }} onContextMenu={e => { e.preventDefault(); openContextMenu(item, e) }}
                    className={'depth-' + Math.min(item.depth || 0, 12) + ' flex items-center gap-2 py-1 pr-2 rounded hover:bg-surface-active cursor-pointer text-foreground-secondary'}>
                    <FileText size={14} className="text-zinc-500 shrink-0" />
                    <span className="truncate">{stripMarkdownExt(item.name)}</span>
                  </div>
                )}
              </div>
            ))}
            {trashOpen && (
              <>
                <div className="flex items-center justify-between px-1 pb-1">
                  <span className="text-zinc-600 uppercase tracking-wider text-xs">Trash ({trashItems.length})</span>
                  <button onClick={() => setTrashOpen(false)} className="text-xs text-foreground-subtle hover:text-foreground-secondary cursor-pointer bg-transparent border-none">Back</button>
                </div>
                {trashItems.length === 0 && <div className="text-zinc-500 italic text-xs p-2">Trash is empty</div>}
                {trashItems.map(item => (
                  <div key={item.name} onClick={() => restoreItem(item)} title="Restore" className="flex items-center gap-2 py-1 pr-2 rounded hover:bg-surface-active cursor-pointer">
                    <RotateCcw size={13} className="text-zinc-500 shrink-0" />
                    <span className="truncate flex-1">{item.original}</span>
                    <span className="text-[10px] text-zinc-600 shrink-0">{new Date(item.deleted_at).toLocaleDateString()}</span>
                  </div>
                ))}
                {trashItems.length > 0 && (
                  <button onClick={emptyTrash} disabled={trashItems.length === 0} className="w-full mt-1 text-[11px] text-danger cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 bg-transparent border-none py-1">Empty Trash</button>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center p-4 text-sm text-zinc-500 italic">Open a vault to start</div>
        )}
      {isOpen && !isTauri && (
        <button onClick={toggleTrash} disabled={trashItems.length === 0} className={'flex items-center gap-2 px-3 py-2 border-t border-border-subtle text-[13px] w-full text-left disabled:opacity-40 disabled:cursor-not-allowed ' + (trashOpen ? 'text-foreground-secondary' : 'text-foreground-subtle') + (trashItems.length > 0 ? ' cursor-pointer hover:bg-surface-active' : '')}>
          <Trash size={14} className="text-zinc-500 shrink-0" />
          Trash
          {trashItems.length > 0 && <span className="ml-auto text-[10px] text-zinc-600">{trashItems.length}</span>}
        </button>
      )}
      <div className="max-h-32 overflow-y-auto text-xs">
        <BacklinksPanel />
      </div>
      <div className="flex items-center justify-start px-2 py-2 shrink-0">
        <button onClick={(e) => { onOpenSettings(); e.currentTarget.blur() }} aria-label="Open settings" className="flex items-center gap-2 w-full cursor-pointer p-2 rounded-md hover:bg-surface-active text-zinc-400 hover:text-foreground transition-colors text-left">
          <Settings size={16} />
          <span className="text-[13px]">Settings</span>
        </button>
      </div>
      {ctxItem && (
        <div ref={ctxMenuRef} data-ctx-menu className="fixed bg-surface border border-border rounded-lg p-1 min-w-[120px] z-[100] shadow-[0_4px_12px_rgba(0,0,0,0.3)]" style={{ top: ctxPos.y, left: ctxPos.x }}>
          <button onClick={async () => {
              closeContextMenu()
              setRenaming({ path: ctxItem.path, name: ctxItem.name, type: ctxItem.type })
            }}
            className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer text-[13px] text-foreground-secondary bg-transparent border-none rounded w-full text-left hover:bg-surface-active">Rename</button>
          <button onClick={async () => {
              closeContextMenu()
              try { await invoke('delete_file', { path: ctxItem.path }); await loadTree(); await loadTrash(); useEditorStore.getState().setTabDeleted(ctxItem.path, true) } catch(e) { console.error(e); toast.error('Failed to delete') }
            }}
            className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer text-[13px] text-danger bg-transparent border-none rounded w-full text-left hover:bg-surface-active">Delete</button>
        </div>
      )}
      {confirmClose && (
        <div role="alertdialog" aria-label="Close vault" className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50" onClick={() => setConfirmClose(false)}>
          <div className="bg-surface border border-border rounded-xl p-4 w-72 shadow-[0_10px_30px_rgba(0,0,0,0.4)]" onClick={e => e.stopPropagation()}>
            <div className="text-sm font-semibold mb-1">Close vault?</div>
            <div className="text-xs text-foreground-secondary mb-4">Unsaved changes will be saved before closing.</div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmClose(false)} className="text-xs px-3 py-1.5 rounded border border-border-subtle bg-transparent text-foreground-secondary cursor-pointer hover:bg-surface-active">Cancel</button>
              <button onClick={async () => { setConfirmClose(false); await closeVault() }} className="text-xs px-3 py-1.5 rounded bg-danger text-white cursor-pointer border-none">Close</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
