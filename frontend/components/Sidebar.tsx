import { useState, useEffect, useRef, useCallback } from 'react'
import { useVaultStore } from '../stores/vault'
import { useEditorStore } from '../stores/editor'
import { invoke, isTauri } from '../lib/ipc'
import { Search, Folder, FileText, FolderOpen, Plus, X, Command, Settings, Option, PanelLeftClose, Trash, RotateCcw, ArrowBigUp } from 'lucide-react'
import { toast } from 'sonner'
import SettingsModal from './SettingsModal'
import { useClickOutside } from '../hooks/useClickOutside'
import { useKeyboard } from '../hooks/useKeyboard'
import { MARKDOWN_EXTENSIONS } from '../utils/fileKind'
const stripMarkdownExt = (name: string) =>
  MARKDOWN_EXTENSIONS.some(e => name.toLowerCase().endsWith(e)) ? name.replace(/\.(md|mdx)$/i, '') : name

/** Search modal overlay — command-palette style search. */
function SearchModal({ onClose, onSelect }: { onClose: () => void; onSelect: (path: string) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{path:string;name:string}[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const { openFile } = useEditorStore()

  useEffect(() => { inputRef.current?.focus() }, [])

  // Search vault when query changes
  useEffect(() => {
    if (!query.trim()) { setResults([]); return }
    const timer = setTimeout(() => {
      invoke<string>('search_vault', { query }).then(s => {
        try { const r = JSON.parse(s).slice(0, 20); setResults(r); setSelectedIdx(0) } catch {}
      }).catch(e => console.error('Search:', e))
    }, 200)
    return () => clearTimeout(timer)
  }, [query])

  // Keyboard navigation
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, results.length - 1)) }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)) }
      if (e.key === 'Enter' && results[selectedIdx]) {
        const p = results[selectedIdx].path
        const parent = p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : ''
        onSelect(parent)
        openFile(p, results[selectedIdx].name)
        onClose()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose, results, selectedIdx, openFile, onSelect])

  /** Keep the highlighted result in view when navigating with the keyboard. */
  useEffect(() => {
    const el = resultsRef.current?.children[selectedIdx] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25)] w-[500px] max-h-[50vh] overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border">
          <Search size={16} className="text-muted shrink-0" />
          <input ref={inputRef} type="text" value={query} onChange={e => setQuery(e.target.value)}
            className="w-full bg-transparent text-sm text-foreground outline-none border-none" placeholder="Search files..." />
          <button onClick={onClose} className="p-1 rounded cursor-pointer bg-transparent text-muted hover:text-foreground-secondary"><X size={16} /></button>
        </div>
        <div ref={resultsRef} className="overflow-y-auto max-h-[40vh] p-2">
          {results.length === 0 && query && <div className="py-6 px-3 text-sm text-muted text-center">No files found</div>}
          {results.map((item, i) => (
            <div key={item.path} onClick={() => { 
              const parent = item.path.includes('/') ? item.path.substring(0, item.path.lastIndexOf('/')) : ''
              onSelect(parent)
              openFile(item.path, item.name); onClose() }}
              className={'flex items-center gap-3 px-3 py-2 cursor-pointer text-sm rounded ' + (i === selectedIdx ? 'bg-surface-active text-foreground' : 'text-foreground-secondary')}>
              <FileText size={14} className="text-muted shrink-0" />
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">{stripMarkdownExt(item.name)}</span>
              <span className="text-xs text-muted overflow-hidden text-ellipsis whitespace-nowrap ml-auto">{item.path}</span>
            </div>
          ))}
          {!query && <div className="py-6 px-3 text-sm text-muted text-center">Type to search files...</div>}
        </div>
      </div>
    </div>
  )
}

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

export default function Sidebar({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [creating, setCreating] = useState<'file'|'folder'|null>(null)
  const [showPlusMenu, setShowPlusMenu] = useState(false)
  const [newName, setNewName] = useState('')
  const newInputRef = useRef<HTMLInputElement>(null)
  const plusMenuRef = useRef<HTMLSpanElement>(null)
  const ctxMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (creating) setTimeout(() => newInputRef.current?.focus(), 50)
  }, [creating])

  const closeContextMenu = () => setCtxItem(null)

  // Close popups / menus on click outside
  useClickOutside(plusMenuRef, () => setShowPlusMenu(false))
  useClickOutside(newInputRef, () => { if (creating) { setCreating(null); setNewName('') } })
  useClickOutside(ctxMenuRef, closeContextMenu)

  const handleCreate = async () => {
    if (!newName.trim() || !isOpen || !creating) return
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
      loadTree()
      setNewName('')
      setCreating(null)
    } catch(e) { console.error(e); toast.error('Failed to create') }
  }
  const { name, isOpen, visibleItems, loading, openVault, closeVault, toggleFolder, loadTree } = useVaultStore()
  const { openFile } = useEditorStore()

  // Context menu
  const [ctxItem, setCtxItem] = useState<{path:string;name:string;type:string}|null>(null)
  const [ctxPos, setCtxPos] = useState({x:0,y:0})
  const openContextMenu = (item: any, e: React.MouseEvent) => { setCtxItem(item); setCtxPos({x: e.clientX, y: e.clientY}) }
  const [renaming, setRenaming] = useState<{path:string;name:string}|null>(null)
  const renameRef = useRef<HTMLInputElement>(null)
  const [currentFolder, setCurrentFolder] = useState('')
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
    try { await invoke('restore_file', { trashName: item.name }); toast.success('Restored ' + item.original); await loadTrash(); loadTree() } catch(e) { console.error(e); toast.error('Restore failed') }
  }
  const emptyTrash = async () => {
    try { await invoke('empty_trash'); setTrashItems([]); loadTree() } catch(e) { console.error(e); toast.error('Failed to empty trash') }
  }

  useEffect(() => {
    if (renaming) setTimeout(() => renameRef.current?.focus(), 50)
  }, [renaming])

  // Keyboard shortcuts
  useKeyboard((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === 'f') {
      e.preventDefault()
      if (!isOpen) { toast.error('Open a vault first — press ⌘O'); return }
      setSearchOpen(true)
    }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === 'o') { e.preventDefault(); openVault() }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === 'p') {
      e.preventDefault()
      if (!isOpen) { toast.error('Open a vault first — press ⌘O'); return }
      setSearchOpen(true)
    }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === ',') { e.preventDefault(); setSettingsOpen(true) }
    if (e.key === 'Escape' && settingsOpen) { setSettingsOpen(false) }
    /** New file/folder. Canonical (all platforms): ⌘⇧F / ⌘⌥⇧F — browsers
     *  reserve ⌘N / ⌘⇧N / ⌘⌥N (new window / private window) and never deliver
     *  them to the page, so web only ever sees the canonical mapping. Native
     *  keeps ⌘N / ⌘⌥N as a bonus alias for the same actions. */
    const mod = e.metaKey || e.ctrlKey
    const newFile = (mod && e.shiftKey && !e.altKey && e.code === 'KeyF') || (mod && !e.shiftKey && !e.altKey && e.code === 'KeyN')
    const newFolder = (mod && e.shiftKey && e.altKey && e.code === 'KeyF') || (mod && !e.shiftKey && e.altKey && e.code === 'KeyN')
    if (newFile) {
      e.preventDefault()
      if (!isOpen) { toast.error('Open a vault first — press ⌘O'); return }
      setCreating('file'); setNewName('')
    }
    if (newFolder) {
      e.preventDefault()
      if (!isOpen) { toast.error('Open a vault first — press ⌘O'); return }
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

  return (
    <aside className="ui-shell w-56 bg-surface border-r border-border-subtle flex flex-col shrink-0 h-full">
      {searchOpen && <SearchModal onClose={() => setSearchOpen(false)} onSelect={(path) => setCurrentFolder(path)} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      <div className="flex items-center justify-between border-b border-border-subtle px-2 py-3">
        <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider truncate">{isOpen ? name : 'No vault'}</span>
        <span className="flex items-center gap-1 shrink-0 ml-2">
          <span className="tip-wrap tip-bar">
            <button onClick={onToggleSidebar} aria-label="Collapse sidebar" className="hover:text-foreground-secondary transition-colors p-1 cursor-pointer bg-transparent border-none rounded flex text-foreground-subtle">
              <PanelLeftClose size={14} />
            </button>
            <span className="tip">Collapse sidebar <kbd><Command size={11} />J</kbd></span>
          </span>
          {isOpen && (
            <button onClick={closeVault} className="text-zinc-600 hover:text-foreground-secondary text-xs p-1 cursor-pointer bg-transparent border-none rounded">[x]</button>
          )}
        </span>
      </div>

      {isOpen ? (
        <div className="flex-1 p-2 text-sm overflow-y-auto space-y-0.5" onClick={e => { if (e.target === e.currentTarget) setCurrentFolder('') }}>
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
                      loadTree()
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
      <div className="flex items-center justify-evenly border-t border-border-subtle px-1 py-3">
        <span className="tip-wrap">
          <button onClick={(e) => { openVault(); e.currentTarget.blur() }} className="cursor-pointer p-3 rounded-md hover:bg-surface-active text-zinc-400 hover:text-foreground transition-colors">
            <Folder size={18} />
          </button>
          <span className="tip">Open project <kbd><Command size={11} />O</kbd></span>
        </span>
        <span className="tip-wrap relative" ref={plusMenuRef}>
            <button onClick={(e) => { setShowPlusMenu(o => !o); e.currentTarget.blur() }} data-plus-btn disabled={!isOpen} className="cursor-pointer p-3 rounded-md hover:bg-surface-active text-zinc-400 hover:text-foreground transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent">
              <Plus size={18} />
            </button>
            <span className="tip">{isOpen ? 'Create a file/folder' : 'Open a vault to create files'}</span>
          {showPlusMenu && (
            <div data-plus-popup className="absolute bottom-full left-0 mb-1 bg-surface border border-border rounded-lg p-1 min-w-[180px] z-50 shadow-[0_4px_12px_rgba(0,0,0,0.3)]">
              <button onClick={() => { setShowPlusMenu(false); setCreating('file'); setNewName('') }}
                className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer text-[13px] text-foreground-secondary bg-transparent border-none rounded w-full text-left hover:bg-surface-active">
                <FileText size={14} /> New File
                <span className="ml-auto text-[10px] text-muted font-mono flex items-center gap-0.5 whitespace-nowrap"><kbd className="inline-flex items-center gap-0.5 bg-background px-1 py-0.5 rounded-[3px] text-[10px]"><Command size={9} />{isTauri ? 'N' : <><ArrowBigUp size={9} />F</>}</kbd></span>
              </button>
              <button onClick={() => { setShowPlusMenu(false); setCreating('folder'); setNewName('') }}
                className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer text-[13px] text-foreground-secondary bg-transparent border-none rounded w-full text-left hover:bg-surface-active">
                <Folder size={14} /> New Folder
                <span className="ml-auto text-[10px] text-muted font-mono flex items-center gap-0.5 whitespace-nowrap"><kbd className="inline-flex items-center gap-0.5 bg-background px-1 py-0.5 rounded-[3px] text-[10px]"><Option size={9} /><Command size={9} />{isTauri ? 'N' : <><ArrowBigUp size={9} />F</>}</kbd></span>
              </button>
            </div>
          )}
        </span>
        <span className="tip-wrap">
          <button onClick={(e) => { setSearchOpen(true); e.currentTarget.blur() }} disabled={!isOpen} className="cursor-pointer p-3 rounded-md hover:bg-surface-active text-zinc-400 hover:text-foreground transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent">
            <Search size={18} />
          </button>
          <span className="tip">{isOpen ? <>Search project files <kbd><Command size={11} />F</kbd></> : 'Open a vault to search files'}</span>
        </span>
        <span className="tip-wrap">
          <button onClick={(e) => { setSettingsOpen(true); e.currentTarget.blur() }} className="cursor-pointer p-3 rounded-md hover:bg-surface-active text-zinc-400 hover:text-foreground transition-colors">
            <Settings size={18} />
          </button>
          <span className="tip">Settings <kbd><Command size={11} />,</kbd></span>
        </span>
      </div>
      <div className="border-t border-border-subtle max-h-32 overflow-y-auto text-xs">
        <BacklinksPanel />
      </div>
      {ctxItem && (
        <div ref={ctxMenuRef} data-ctx-menu className="fixed bg-surface border border-border rounded-lg p-1 min-w-[120px] z-[100] shadow-[0_4px_12px_rgba(0,0,0,0.3)]" style={{ top: ctxPos.y, left: ctxPos.x }}>
          <button onClick={async () => {
              closeContextMenu()
              setRenaming({ path: ctxItem.path, name: ctxItem.name })
            }}
            className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer text-[13px] text-foreground-secondary bg-transparent border-none rounded w-full text-left hover:bg-surface-active">Rename</button>
          <button onClick={async () => {
              closeContextMenu()
              try { await invoke('delete_file', { path: ctxItem.path }); loadTree(); loadTrash(); useEditorStore.getState().setTabDeleted(ctxItem.path, true) } catch(e) { console.error(e); toast.error('Failed to delete') }
            }}
            className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer text-[13px] text-danger bg-transparent border-none rounded w-full text-left hover:bg-surface-active">Delete</button>
        </div>
      )}
    </aside>
  )
}
