import { useState, useEffect, useRef } from 'react'
import { useVaultStore } from '../stores/vault'
import { useEditorStore } from '../stores/editor'
import { invoke } from '@tauri-apps/api/core'
import { Search, Folder, FileText, FolderOpen, Plus, X, Command, Settings, Option } from 'lucide-react'
import { toast } from 'sonner'
import AiSettingsModal from './AiSettingsModal'
import { useClickOutside } from '../hooks/useClickOutside'
import { useKeyboard } from '../hooks/useKeyboard'

/** Search modal overlay — like Zed's command palette search. */
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

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]" onClick={onClose}>
      <div style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)', width: 500, maxHeight: '50vh', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px', borderBottom: '1px solid var(--border)' }}>
          <Search size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          <input ref={inputRef} type="text" value={query} onChange={e => setQuery(e.target.value)}
            style={{ width: '100%', background: 'transparent', fontSize: 14, color: 'var(--text-primary)', outline: 'none', border: 'none' }} placeholder="Search files..." />
          <button onClick={onClose} style={{ padding: 4, borderRadius: 4, cursor: 'pointer', background: 'transparent', color: 'var(--text-muted)' }}><X size={16} /></button>
        </div>
        <div ref={resultsRef} style={{ overflowY: 'auto', maxHeight: '40vh', padding: 8 }}>
          {results.length === 0 && query && <div style={{ padding: '24px 12px', fontSize: 14, color: 'var(--text-muted)', textAlign: 'center' }}>No files found</div>}
          {results.map((item, i) => (
            <div key={item.path} onClick={() => { 
              const parent = item.path.includes('/') ? item.path.substring(0, item.path.lastIndexOf('/')) : ''
              onSelect(parent)
              openFile(item.path, item.name); onClose() }}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', cursor: 'pointer', fontSize: 14, borderRadius: 4, backgroundColor: i === selectedIdx ? 'var(--bg-hover)' : 'transparent', color: i === selectedIdx ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
              <FileText size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginLeft: 'auto' }}>{item.path}</span>
            </div>
          ))}
          {!query && <div style={{ padding: '24px 12px', fontSize: 14, color: 'var(--text-muted)', textAlign: 'center' }}>Type to search files...</div>}
        </div>
      </div>
    </div>
  )
}

/** Panel showing backlinks for the currently active file. */
function BacklinksPanel() {
  const [items, setItems] = useState<{path:string;name:string}[]>([])
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
          className="text-zinc-500 hover:text-zinc-300 cursor-pointer py-1 px-1 truncate rounded hover:bg-[var(--bg-hover)]">
          {item.name}
        </div>
      ))}
    </div>
  )
}

export default function Sidebar() {
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
      const name = newName.trim()
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

  useEffect(() => {
    if (renaming) setTimeout(() => renameRef.current?.focus(), 50)
  }, [renaming])

  // Keyboard shortcuts
  useKeyboard((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); setSearchOpen(true) }
    if ((e.metaKey || e.ctrlKey) && e.key === 'o') { e.preventDefault(); openVault() }
    if ((e.metaKey || e.ctrlKey) && e.key === 'p') { e.preventDefault(); setSearchOpen(true) }
    if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); setSettingsOpen(true) }
    if (e.key === 'Escape' && settingsOpen) { setSettingsOpen(false) }
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyN' && !e.altKey) { e.preventDefault(); if (!isOpen) return; setCreating('file'); setNewName('') }
    if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyN') { e.preventDefault(); if (!isOpen) return; setCreating('folder'); setNewName('') }
  })

  // Refresh tree on window focus
  useEffect(() => {
    if (!isOpen) return
    const h = () => loadTree()
    window.addEventListener('focus', h)
    return () => window.removeEventListener('focus', h)
  }, [isOpen, loadTree])

  return (
    <aside className="ui-shell w-56 bg-[var(--bg-secondary)] border-r border-[var(--border-subtle)] flex flex-col shrink-0 h-full">
      {searchOpen && <SearchModal onClose={() => setSearchOpen(false)} onSelect={(path) => setCurrentFolder(path)} />}
      {settingsOpen && <AiSettingsModal onClose={() => setSettingsOpen(false)} />}
      <div className="flex-1 flex flex-col overflow-y-auto">
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)]" style={{ padding: '12px 8px' }}>
          {isOpen ? (
            <><span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider truncate">{name}</span><button onClick={closeVault} className="text-zinc-600 hover:text-zinc-300 text-xs shrink-0 ml-2">[x]</button></>
          ) : <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">No vault</span>}
        </div>

        {isOpen ? (
          <div className="flex-1 p-2 text-sm overflow-y-auto space-y-0.5" onClick={e => { if (e.target === e.currentTarget) setCurrentFolder('') }}>
            {loading && <div className="text-zinc-500 text-xs p-2">Loading...</div>}
            {!loading && visibleItems.length === 0 && !creating && <div className="text-zinc-500 italic text-xs p-2">Empty vault</div>}
            {renaming && (
              <input ref={renameRef} type="text" defaultValue={renaming.name}
                style={{ width: '100%', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13, padding: '6px 10px', borderRadius: 4, border: '1px solid var(--accent)', outline: 'none', marginBottom: 4 }}
                onKeyDown={async e => {
                  if (e.key === 'Enter') {
                    const dir = renaming.path.substring(0, renaming.path.lastIndexOf('/') + 1)
                    const newPath = dir + (e.target as HTMLInputElement).value
                    try { await invoke('rename_file', { from: renaming.path, to: newPath }); loadTree() } catch(err) { console.error(err); toast.error('Failed to rename') }
                    setRenaming(null)
                  }
                  if (e.key === 'Escape') setRenaming(null)
                }} />
            )}
            {creating && (
              <input ref={newInputRef} type="text" value={newName} onChange={e => setNewName(e.target.value)}
                placeholder={creating === 'file' ? (currentFolder ? 'File in ' + currentFolder + '/' : 'Filename...') : (currentFolder ? 'Folder in ' + currentFolder + '/' : 'Folder name...')}
                style={{ width: '100%', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13, padding: '6px 10px', borderRadius: 4, border: '1px solid var(--accent)', outline: 'none', marginBottom: 4 }}
                onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') { setCreating(null); setNewName('') } }} />
            )}
            {visibleItems.map(item => (
              <div key={item.path}>
                {item.type === '1' ? (
                  <div onClick={() => { toggleFolder(item); setCurrentFolder(item.path) }} onContextMenu={e => { e.preventDefault(); openContextMenu(item, e) }} style={{ paddingLeft: 8 + (item.depth || 0) * 20 + 'px' }}
                    className={'flex items-center gap-2 py-1 pr-2 rounded hover:bg-[var(--bg-hover)] cursor-pointer ' + (item.isExpanded ? 'text-zinc-300' : 'text-zinc-400')}>
                    {item.isExpanded ? <FolderOpen size={14} /> : <Folder size={14} />}
                    <span className="truncate">{item.name}</span>
                  </div>
                ) : (
                  <div onClick={() => { openFile(item.path, item.name); setCurrentFolder(item.path.includes('/') ? item.path.substring(0, item.path.lastIndexOf('/')) : '') }} onContextMenu={e => { e.preventDefault(); openContextMenu(item, e) }} style={{ paddingLeft: 8 + (item.depth || 0) * 20 + 'px' }}
                    className="flex items-center gap-2 py-1 pr-2 rounded hover:bg-[var(--bg-hover)] cursor-pointer text-zinc-300">
                    <FileText size={14} className="text-zinc-500 shrink-0" />
                    <span className="truncate">{item.name}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center p-4 text-sm text-zinc-500 italic">Open a vault to start</div>
        )}
      </div>

      <div className="flex items-center gap-4 border-t border-[var(--border-subtle)]" style={{ padding: '12px 8px' }}>
        <span className="tip-wrap">
          <button onClick={openVault} className="cursor-pointer p-3 rounded-md hover:bg-[var(--bg-hover)] text-zinc-400 hover:text-zinc-200 transition-colors">
            <Folder size={18} />
          </button>
          <span className="tip">Open project <kbd><Command size={11} />O</kbd></span>
        </span>
        <span className="tip-wrap">
          <button onClick={() => setSearchOpen(true)} className="cursor-pointer p-3 rounded-md hover:bg-[var(--bg-hover)] text-zinc-400 hover:text-zinc-200 transition-colors">
            <Search size={18} />
          </button>
          <span className="tip">Search project files <kbd><Command size={11} />F</kbd></span>
        </span>
        <span className="tip-wrap">
          <button onClick={() => setSettingsOpen(true)} className="cursor-pointer p-3 rounded-md hover:bg-[var(--bg-hover)] text-zinc-400 hover:text-zinc-200 transition-colors">
            <Settings size={18} />
          </button>
          <span className="tip">AI Settings <kbd><Command size={11} />,</kbd></span>
        </span>
        <span className="tip-wrap" style={{ position: 'relative' }} ref={plusMenuRef}>
            <button onClick={() => setShowPlusMenu(o => !o)} data-plus-btn className="cursor-pointer p-3 rounded-md hover:bg-[var(--bg-hover)] text-zinc-400 hover:text-zinc-200 transition-colors">
              <Plus size={18} />
            </button>
            <span className="tip">Create a file/folder</span>
          {showPlusMenu && (
            <div data-plus-popup style={{ position: 'absolute', bottom: '100%', left: 0, marginBottom: 4, backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 4, minWidth: 180, zIndex: 50, boxShadow: '0 4px 12px rgba(0,0,0,0.3)' }}>
              <button onClick={() => { setShowPlusMenu(false); setCreating('file'); setNewName('') }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)', background: 'transparent', border: 'none', borderRadius: 4, width: '100%', textAlign: 'left' }}
                onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--bg-hover)'}
                onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}>
                <FileText size={14} /> New File
                <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace', display: 'flex', alignItems: 'center', gap: 2, whiteSpace: "nowrap" }}><kbd style={{ display: "inline-flex", alignItems: "center", gap: 2, background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: 3, fontSize: 10 }}><Command size={9} />N</kbd></span>
              </button>
              <button onClick={() => { setShowPlusMenu(false); setCreating('folder'); setNewName('') }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)', background: 'transparent', border: 'none', borderRadius: 4, width: '100%', textAlign: 'left' }}
                onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--bg-hover)'}
                onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}>
                <Folder size={14} /> New Folder
                <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace', display: 'flex', alignItems: 'center', gap: 2, whiteSpace: "nowrap" }}><kbd style={{ display: "inline-flex", alignItems: "center", gap: 2, background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: 3, fontSize: 10 }}><Option size={9} /><Command size={9} />N</kbd></span>
              </button>
            </div>
          )}
        </span>
      </div>
      <div className="border-t border-[var(--border-subtle)] max-h-32 overflow-y-auto text-xs">
        <BacklinksPanel />
      </div>
      {ctxItem && (
        <div ref={ctxMenuRef} data-ctx-menu style={{ position: 'fixed', top: ctxPos.y, left: ctxPos.x, backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 4, minWidth: 120, zIndex: 100, boxShadow: '0 4px 12px rgba(0,0,0,0.3)' }}>
          <button onClick={async () => {
              closeContextMenu()
              setRenaming({ path: ctxItem.path, name: ctxItem.name })
            }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)', background: 'transparent', border: 'none', borderRadius: 4, width: '100%', textAlign: 'left' }}
            onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--bg-hover)'}
            onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}>Rename</button>
          <button onClick={async () => {
              closeContextMenu()
              try { await invoke('delete_file', { path: ctxItem.path }); loadTree(); useEditorStore.getState().setTabDeleted(ctxItem.path, true) } catch(e) { console.error(e); toast.error('Failed to delete') }
            }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer', fontSize: 13, color: 'var(--danger)', background: 'transparent', border: 'none', borderRadius: 4, width: '100%', textAlign: 'left' }}
            onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--bg-hover)'}
            onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}>Delete</button>
        </div>
      )}
    </aside>
  )
}
