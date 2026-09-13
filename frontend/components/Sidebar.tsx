import { useState, useEffect, useRef, useCallback } from 'react'
import { useVaultStore } from '../stores/vault'
import { useEditorStore } from '../stores/editor'
import { useAiThreads } from '../stores/aiThreads'
import { invoke, isMacTauri, isTauri } from '../lib/ipc'
import { Search, Check, ChevronsUpDown, Folder, FileText, FolderOpen, Plus, X, Command, Settings, Option, ArrowBigUp } from 'lucide-react'
import { toast } from 'sonner'
import { useClickOutside } from '../hooks/useClickOutside'
import { useKeyboard } from '../hooks/useKeyboard'
import { MARKDOWN_EXTENSIONS, stripMarkdownExt } from '../utils/fileKind'
import SidebarFooter from './SidebarFooter'
import AiChatPanel from './panels/AiChatPanel'
import GitPanel from './panels/GitPanel'
import SidebarTabMenu, { type SidebarPanelId } from './panels/SidebarTabMenu'
import TrashPanel, { type TrashItem } from './panels/TrashPanel'

/** Panel showing backlinks for the currently active file. */
function BacklinksPanel({ onNavigate }: { onNavigate: () => void }) {
  const [items, setItems] = useState<{path:string;name:string;snippet:string}[]>([])
  const { openFile } = useEditorStore()
  const activeTab = useEditorStore(s => s.activeTab)

  /* oxlint-disable react/set-state-in-effect -- clears backlinks when no tab is active */
  useEffect(() => {
    if (!activeTab) { setItems([]); return }
    invoke<string>('wiki_backlinks', { path: activeTab }).then(s => { try { setItems(JSON.parse(s)) } catch(e) { console.error('Backlinks parse:', e); setItems([]) } }).catch(e => console.error('Backlinks:', e))
  }, [activeTab])
  /* oxlint-enable react/set-state-in-effect */

  if (items.length === 0) return null
  return (
    <div className="p-2">
      <div className="text-muted uppercase tracking-wider mb-1 px-1">Backlinks ({items.length})</div>
      {items.map(item => (
        <div key={item.path} onClick={async () => { await openFile(item.path, item.name); onNavigate() }}
          className="text-foreground-subtle hover:text-foreground-secondary cursor-pointer py-1 px-1 rounded hover:bg-surface-active">
          <div className="truncate">{item.name}</div>
          {item.snippet && <div className="truncate text-[10px] text-muted">{item.snippet}</div>}
        </div>
      ))}
    </div>
  )
}

interface SidebarProps {
  id?: string
  onOpenSettings: () => void
  onOpenSearch: () => void
  onOpenShortcuts: () => void
  onRequestCloseVault: () => void
  onNavigate?: () => void
  registerSearchFolder: (fn: (path: string) => void) => () => void
}

export default function Sidebar({ id, onOpenSettings, onOpenSearch, onOpenShortcuts, onRequestCloseVault, onNavigate = () => {}, registerSearchFolder }: SidebarProps) {
  const [creating, setCreating] = useState<'file'|'folder'|null>(null)
  const [showPlusMenu, setShowPlusMenu] = useState(false)
  const [newName, setNewName] = useState('')
  const newInputRef = useRef<HTMLInputElement>(null)
  const createBusyRef = useRef(false)
  const plusMenuRef = useRef<HTMLSpanElement>(null)
  const ctxMenuRef = useRef<HTMLDivElement>(null)
  const vaultMenuRef = useRef<HTMLSpanElement>(null)
  const [vaultMenuOpen, setVaultMenuOpen] = useState(false)
  const [activePanel, setActivePanel] = useState<SidebarPanelId>('vault')

  useEffect(() => {
    if (creating) setTimeout(() => newInputRef.current?.focus(), 50)
  }, [creating])

  /** Declared before closeContextMenu so it reads an initialized binding (react/immutability). */
  const [ctxItem, setCtxItem] = useState<{path:string;name:string;type:string}|null>(null)
  const [ctxPos, setCtxPos] = useState({x:0,y:0})
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
        await openFile(p, name)
      }
      if (useVaultStore.getState().vaultPath !== targetVaultPath || !useVaultStore.getState().isOpen) return
      await loadTree()
      setNewName('')
      setCreating(null)
      if (creating === 'file') onNavigate()
    } catch(e) { console.error(e); toast.error('Failed to create') }
    finally { createBusyRef.current = false }
  }
  const { name, isOpen, vaultPath, recent, visibleItems, loading, openVault, openRecent, toggleFolder, loadTree } = useVaultStore()
  const { openFile } = useEditorStore()

  const openContextMenu = (item: any, e: React.MouseEvent) => { setCtxItem(item); setCtxPos({x: e.clientX, y: e.clientY }) }
  const [renaming, setRenaming] = useState<{path:string;name:string;type:string}|null>(null)
  const renameRef = useRef<HTMLInputElement>(null)
  const [currentFolder, setCurrentFolder] = useState('')
  /** Keep the modal's onSelect wired to the sidebar's create-target folder:
   *  search is owned by App (works with the sidebar closed), which calls this
   *  callback only while the sidebar is mounted. */
  useEffect(() => registerSearchFolder(setCurrentFolder), [registerSearchFolder])
  /* oxlint-disable react/set-state-in-effect -- resets local UI state on vault change */
  useEffect(() => {
    setCurrentFolder('')
    setCreating(null)
    setNewName('')
    setActivePanel('vault')
  }, [vaultPath, isOpen])
  /* oxlint-enable react/set-state-in-effect */
  const [trashItems, setTrashItems] = useState<TrashItem[]>([])
  const [trashLoading, setTrashLoading] = useState(false)
  const [trashError, setTrashError] = useState('')
  const loadTrash = useCallback(async () => {
    setTrashLoading(true)
    setTrashError('')
    try {
      const raw = await invoke<string>('list_trash')
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      setTrashItems(Array.isArray(parsed) ? parsed : [])
    } catch(e) {
      console.error(e)
      setTrashError(String(e))
    } finally {
      setTrashLoading(false)
    }
  }, [])
  const selectPanel = async (panel: SidebarPanelId) => {
    setShowPlusMenu(false)
    setVaultMenuOpen(false)
    closeContextMenu()
    setActivePanel(panel)
    if (panel === 'trash') await loadTrash()
  }
  const restoreItem = async (item: TrashItem) => {
    try {
      await invoke('restore_file', { trashName: item.name })
      toast.success('Restored ' + item.original)
      await loadTrash()
      await loadTree()
    } catch(e) { console.error(e); toast.error(String(e)) }
  }
  const deleteTrashItem = async (item: TrashItem) => {
    if (!window.confirm(`Delete "${item.original}" permanently? This cannot be undone.`)) return
    try {
      await invoke('delete_trash_item', { trashName: item.name })
      toast.success('Deleted permanently')
      await loadTrash()
    } catch(e) { console.error(e); toast.error(String(e)) }
  }
  const emptyTrash = async () => {
    if (!window.confirm('Permanently delete every item in Trash? This cannot be undone.')) return
    try {
      await invoke('empty_trash')
      await loadTrash()
      await loadTree()
    } catch(e) { console.error(e); toast.error(String(e)) }
  }

  useEffect(() => {
    if (renaming) setTimeout(() => renameRef.current?.focus(), 50)
  }, [renaming])

  // Keyboard shortcuts
  useKeyboard((e: KeyboardEvent) => {
    if (e.key === 'Escape') { setShowPlusMenu(false); setVaultMenuOpen(false) }
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
      setActivePanel('vault'); setCreating('file'); setNewName('')
    }
    if (newFolder) {
      e.preventDefault()
      if (!isOpen || loading) { toast.error('Open a vault first — press ⌘O'); return }
      setActivePanel('vault'); setCreating('folder'); setNewName('')
    }
  })

  // Refresh tree on window focus
  /* oxlint-disable react/set-state-in-effect -- refreshes trash/tree state from disk */
  useEffect(() => {
    if (!isOpen && !isTauri) return
    if (!isTauri || activePanel === 'trash') loadTrash()
    const h = () => {
      if (isOpen) void loadTree()
      if (!isTauri || activePanel === 'trash') void loadTrash()
    }
    window.addEventListener('focus', h)
    return () => window.removeEventListener('focus', h)
  }, [activePanel, isOpen, loadTree, loadTrash])
  /* oxlint-enable react/set-state-in-effect */

  /** Shared header icon style - theme tokens only, so +/search/X match in both themes. */
  const iconBtn = 'cursor-pointer p-1 rounded hover:bg-surface-active text-foreground-subtle hover:text-foreground transition-colors'

  return (
    <aside id={id} data-testid={id} className={'ui-shell bg-surface border-r border-border-subtle flex flex-col shrink-0 h-full ' + (isTauri ? 'w-68' : 'w-56')}>
      {isMacTauri ? (
        <div data-tauri-drag-region className="flex h-12 shrink-0 items-center pl-[72px] pr-2">
          <SidebarTabMenu active={activePanel} onChange={panel => void selectPanel(panel)} trashCount={trashItems.length} isNative={isTauri} />
        </div>
      ) : (
        <div className="px-2 pt-2">
          <SidebarTabMenu active={activePanel} onChange={panel => void selectPanel(panel)} trashCount={trashItems.length} isNative={isTauri} />
        </div>
      )}

      {/* Search modal lives in App so ⌘F/⌘P still work with the sidebar closed. */}
      <div className="px-2 py-2">
        <button onClick={onOpenSearch} aria-label="Search project files" className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md border border-border bg-background text-foreground-subtle hover:text-foreground-secondary cursor-pointer transition-colors text-left">
          <Search size={14} className="text-muted shrink-0" />
          <span className="flex-1 truncate text-[13px]">Search</span>
          <kbd className="inline-flex items-center gap-0.5 bg-surface px-1 py-0.5 rounded-[3px] text-[10px] font-mono text-muted border border-border-subtle"><Command size={9} />F</kbd>
        </button>
      </div>

      {isOpen && activePanel === 'vault' && (
        <div className="flex-1 p-2 text-sm overflow-y-auto space-y-0.5">
            {loading && <div className="text-foreground-subtle text-xs p-2">Loading...</div>}
            {!loading && visibleItems.length === 0 && !creating && <div className="text-foreground-subtle italic text-xs p-2">Empty vault</div>}
            {renaming && (
              <input ref={renameRef} type="text" defaultValue={stripMarkdownExt(renaming.name)}
                className="w-full bg-background text-foreground text-[13px] px-2.5 py-1.5 rounded border border-accent outline-none mb-1"
                onKeyDown={async e => {
                  if (e.key === 'Enter') {
                    const dir = renaming.path.substring(0, renaming.path.lastIndexOf('/') + 1)
                    let target = (e.target as HTMLInputElement).value
                    if (MARKDOWN_EXTENSIONS.some(e => renaming.path.toLowerCase().endsWith(e)) && !/\.\w{1,10}$/i.test(target)) target = target + '.md'
                    const newPath = dir + target
                    try {
                      await useEditorStore.getState().flushEditor()
                      await invoke('rename_file', { from: renaming.path, to: newPath })
                      await useEditorStore.getState().renameTab(renaming.path, newPath)
                      useAiThreads.getState().renamePath(renaming.path, newPath)
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
            {creating && (
              <input ref={newInputRef} type="text" value={newName} onChange={e => setNewName(e.target.value)}
                placeholder={creating === 'file' ? (currentFolder ? 'File in ' + currentFolder + '/' : 'Filename...') : (currentFolder ? 'Folder in ' + currentFolder + '/' : 'Folder name...')}
                className="w-full bg-background text-foreground text-[13px] px-2.5 py-1.5 rounded border border-accent outline-none mb-1"
                onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') { setCreating(null); setNewName('') } }} />
            )}
            {visibleItems.map(item => (
              <div key={item.path}>
                {item.type === '1' ? (
                  <div onClick={() => { toggleFolder(item); setCurrentFolder(item.path) }} onContextMenu={e => { e.preventDefault(); openContextMenu(item, e) }}
                    className={'depth-' + Math.min(item.depth || 0, 12) + ' flex items-center gap-2 py-1 pr-2 rounded hover:bg-surface-active cursor-pointer ' + (item.isExpanded ? 'text-foreground-secondary' : 'text-foreground-subtle')}>
                    {item.isExpanded ? <FolderOpen size={14} /> : <Folder size={14} />}
                    <span className="truncate">{item.name}</span>
                  </div>
                ) : (
                  <div onClick={async () => { await openFile(item.path, item.name); setCurrentFolder(item.path.includes('/') ? item.path.substring(0, item.path.lastIndexOf('/')) : ''); onNavigate() }} onContextMenu={e => { e.preventDefault(); openContextMenu(item, e) }}
                    className={'depth-' + Math.min(item.depth || 0, 12) + ' flex items-center gap-2 py-1 pr-2 rounded hover:bg-surface-active cursor-pointer text-foreground-secondary'}>
                    <FileText size={14} className="text-foreground-subtle shrink-0" />
                    <span className="truncate">{stripMarkdownExt(item.name)}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
      )}
      {isOpen && activePanel === 'ai' && <AiChatPanel />}
      {isOpen && activePanel === 'git' && <GitPanel />}
      {(isOpen || isTauri) && activePanel === 'trash' && (
        <TrashPanel
          items={trashItems}
          loading={trashLoading}
          error={trashError}
          onRestore={item => void restoreItem(item)}
          onDelete={item => void deleteTrashItem(item)}
          onEmpty={() => void emptyTrash()}
          onBack={() => setActivePanel('vault')}
        />
      )}
      {!isOpen && activePanel !== 'trash' && <div className="flex-1 flex items-center justify-center p-4 text-sm text-foreground-subtle italic">Open a vault to start</div>}
      {isOpen && activePanel === 'vault' && (
        <div className="max-h-32 overflow-y-auto text-xs">
          <BacklinksPanel onNavigate={onNavigate} />
        </div>
      )}
      <div className="relative flex items-center gap-0.5 px-2 py-1.5 shrink-0">
        <span className="relative flex-1 min-w-0" ref={vaultMenuRef}>
          <button onClick={(e) => { setVaultMenuOpen(o => !o); e.currentTarget.blur() }} disabled={loading} aria-label="Switch vault" aria-expanded={vaultMenuOpen}
            className={'flex items-center gap-1 w-full min-w-0 cursor-pointer rounded px-2 py-1.5 bg-transparent border-none hover:bg-surface-active transition-colors disabled:opacity-40 disabled:cursor-not-allowed ' + (vaultMenuOpen ? 'text-foreground' : 'text-foreground-secondary')}>
            <span className="text-xs font-semibold uppercase tracking-wider truncate">{name}</span>
            <ChevronsUpDown size={14} className="ml-auto shrink-0" />
          </button>
          {vaultMenuOpen && (
            <div data-vault-menu className="ui-popover absolute bottom-full left-0 mb-1 p-1 w-52 max-w-[calc(100vw-1rem)] z-50">
              {recent.length === 0 && <div className="px-2.5 py-1.5 text-[11px] text-foreground-subtle italic">No recent vaults</div>}
              {recent.length > 0 && (
                <div className="max-h-56 overflow-y-auto">
                  {recent.slice(0, 5).map(r => {
                    const active = r.path === vaultPath
                    return (
                      <button key={r.path} onClick={async () => { setVaultMenuOpen(false); if (!active) { await openRecent(r.path); onNavigate() } }}
                        className={'flex items-center gap-2 w-full px-2.5 py-1.5 cursor-pointer text-left bg-transparent border-none rounded text-[12px] hover:bg-surface-active ' + (active ? 'text-foreground cursor-default' : 'text-foreground-secondary')}>
                        {active ? <Check size={13} className="text-accent shrink-0" /> : <Folder size={13} className="text-foreground-subtle shrink-0" />}
                        <span className="truncate flex-1">{r.name}</span>
                      </button>
                    )
                  })}
                </div>
              )}
              <div className="border-t border-border-subtle my-1" />
              <button onClick={() => { setVaultMenuOpen(false); onNavigate(); openVault() }}
                className="flex items-center gap-2 w-full px-2.5 py-1.5 cursor-pointer text-[13px] text-foreground-secondary bg-transparent border-none rounded text-left hover:bg-surface-active">
                <FolderOpen size={14} /> Open Vault
              </button>
              <button onClick={() => { setVaultMenuOpen(false); onRequestCloseVault() }}
                className="flex items-center gap-2 w-full px-2.5 py-1.5 cursor-pointer text-[13px] text-danger bg-transparent border-none rounded text-left hover:bg-surface-active">
                <X size={14} /> Close Vault
              </button>
            </div>
          )}
        </span>
        <span className="tip-wrap relative shrink-0" ref={plusMenuRef}>
          <button onClick={(e) => { setShowPlusMenu(o => !o); e.currentTarget.blur() }} aria-label="Create file or folder" data-plus-btn disabled={loading} className={iconBtn + ' disabled:opacity-30 disabled:cursor-not-allowed'}>
            <Plus size={14} />
          </button>
          <span className="tip tip-left">Create a file/folder</span>
          {showPlusMenu && (
            <div data-plus-popup className="ui-popover absolute bottom-full -right-6 mb-1 p-1 w-52 max-w-[calc(100vw-1rem)] z-50">
              <button onClick={() => { if (loading) return; setShowPlusMenu(false); setActivePanel('vault'); setCreating('file'); setNewName('') }}
                className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer text-[13px] text-foreground-secondary bg-transparent border-none rounded w-full text-left hover:bg-surface-active">
                <FileText size={14} /> New File
                <span className="ml-auto text-[10px] text-muted font-mono flex items-center gap-0.5 whitespace-nowrap"><kbd className="inline-flex items-center gap-0.5 bg-background px-1 py-0.5 rounded-[3px] text-[10px]"><Command size={9} />{isTauri ? 'N' : <><ArrowBigUp size={9} />F</>}</kbd></span>
              </button>
              <button onClick={() => { if (loading) return; setShowPlusMenu(false); setActivePanel('vault'); setCreating('folder'); setNewName('') }}
                className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer text-[13px] text-foreground-secondary bg-transparent border-none rounded w-full text-left hover:bg-surface-active">
                <Folder size={14} /> New Folder
                <span className="ml-auto text-[10px] text-muted font-mono flex items-center gap-0.5 whitespace-nowrap"><kbd className="inline-flex items-center gap-0.5 bg-background px-1 py-0.5 rounded-[3px] text-[10px]"><Option size={9} /><Command size={9} />{isTauri ? 'N' : <><ArrowBigUp size={9} />F</>}</kbd></span>
              </button>
            </div>
          )}
        </span>
        <button data-testid="sidebar-settings" onClick={(e) => { onOpenSettings(); e.currentTarget.blur() }} aria-label="Open settings" title="Settings" className={iconBtn}>
          <Settings size={14} />
        </button>
      </div>
      <SidebarFooter onOpenShortcuts={onOpenShortcuts} />
      {ctxItem && (
        <div ref={ctxMenuRef} data-ctx-menu className="ui-popover fixed p-1 min-w-[120px] z-[100]" style={{ top: ctxPos.y, left: ctxPos.x }}>
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

    </aside>
  )
}
