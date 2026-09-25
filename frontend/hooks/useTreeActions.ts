import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { invoke } from '../lib/ipc'
import { useEditorStore } from '../stores/editor'
import { useVaultStore, type FileInfo } from '../stores/vault'
import { MARKDOWN_EXTENSIONS } from '../utils/fileKind'
import { useClickOutside } from './useClickOutside'

/** What the tree cannot know about its host: where the user should land after a
 *  create, and which panels mirror the vault. */
interface TreeActionsOptions {
  /** Search modal's create target — search is owned by App, which works with the
   *  sidebar closed and calls this callback only while the sidebar is mounted. */
  registerSearchFolder: (fn: (path: string) => void) => () => void
  /** A created file is opened; on a phone that closes the drawer. */
  onNavigate?: () => void
  /** Deleting moves the row to trash, so the trash panel has to reload. */
  onDeleted?: () => Promise<unknown> | unknown
}

/** Create, rename and delete for the vault tree, plus the transient state of the
 *  inline inputs that drive them.
 *
 *  Extracted from the Sidebar so any surface can reach an action — the context
 *  menu, the plus menu, a keyboard shortcut — without owning its flow, and so the
 *  Sidebar itself stays a render. The vault store stays the source of truth for
 *  the tree: every action here ends in `loadTree()`. Create and rename keep their
 *  input in the tree rather than in this hook, so they return state, not JSX. */
export function useTreeActions({ registerSearchFolder, onNavigate = () => {}, onDeleted }: TreeActionsOptions) {
  const { isOpen, loading, vaultPath, toggleFolder, loadTree } = useVaultStore()
  const { openFile } = useEditorStore()

  const [creating, setCreating] = useState<'file' | 'folder' | null>(null)
  const [newName, setNewName] = useState('')
  const newInputRef = useRef<HTMLInputElement>(null)
  const createBusyRef = useRef(false)
  const [renaming, setRenaming] = useState<FileInfo | null>(null)
  const renameRef = useRef<HTMLInputElement>(null)
  /** Target folder of the next create: the row the tree was last pointed at, or
   *  the folder implied by the row a context menu was opened on. */
  const [currentFolder, setCurrentFolder] = useState('')

  useEffect(() => registerSearchFolder(setCurrentFolder), [registerSearchFolder])
  useEffect(() => { if (creating) setTimeout(() => newInputRef.current?.focus(), 50) }, [creating])
  useEffect(() => { if (renaming) setTimeout(() => renameRef.current?.focus(), 50) }, [renaming])

  /* oxlint-disable react/set-state-in-effect -- resets the inputs on vault change */
  useEffect(() => {
    setCurrentFolder('')
    setCreating(null)
    setNewName('')
    /** A rename input left over from the previous vault names a path that no
     *  longer exists here — its Enter would target the old vault. */
    setRenaming(null)
  }, [vaultPath, isOpen])
  /* oxlint-enable react/set-state-in-effect */

  const cancelCreate = () => { setCreating(null); setNewName('') }
  useClickOutside(newInputRef, () => { if (creating) cancelCreate() })

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

  /** Arm the inline create input. Without `item` the entry lands in
   *  `currentFolder` (⌘N and the plus menu); with it, in the clicked row's folder —
   *  the clicked folder itself, or the folder holding the clicked file. A
   *  collapsed target is expanded first, so `loadTree` reveals the new child in
   *  place instead of leaving it inside a closed folder. */
  const startCreate = (kind: 'file' | 'folder', item?: FileInfo) => {
    if (loading) return
    if (item) setCurrentFolder(item.type === '1' ? item.path : (item.path.includes('/') ? item.path.substring(0, item.path.lastIndexOf('/')) : ''))
    setCreating(kind)
    setNewName('')
    if (item && item.type === '1' && !item.isExpanded) void toggleFolder(item)
  }

  const onCreateKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void handleCreate()
    if (e.key === 'Escape') cancelCreate()
  }

  /** The rename input renders in the tree; this only arms it. */
  const startRename = (item: FileInfo) => setRenaming(item)

  /** The entry in the tree and its open tab both carry the old path, so the editor
   *  is flushed and remapped before the reload — a dirty buffer saved after the
   *  move would resurrect the file at the path it was renamed away from. */
  const onRenameKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { setRenaming(null); return }
    if (e.key !== 'Enter' || !renaming) return
    const dir = renaming.path.substring(0, renaming.path.lastIndexOf('/') + 1)
    let target = (e.target as HTMLInputElement).value
    if (MARKDOWN_EXTENSIONS.some(ext => renaming.path.toLowerCase().endsWith(ext)) && !/\.\w{1,10}$/i.test(target)) target = target + '.md'
    const newPath = dir + target
    try {
      await useEditorStore.getState().flushEditor()
      await invoke('rename_file', { from: renaming.path, to: newPath })
      await useEditorStore.getState().renameTab(renaming.path, newPath)
      /* Keep the create-here target in sync: create_file re-creates missing
       * parent dirs, so a stale currentFolder would silently recreate the old
       * folder (A -> Z then new file lands in A/). */
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

  /** Deleting drops the row from the tree, from trash bookkeeping and from the
   *  editor — an open tab would otherwise keep saving into a path that is gone. */
  const deleteItem = async (item: FileInfo) => {
    try {
      await invoke('delete_file', { path: item.path })
      await loadTree()
      await onDeleted?.()
      useEditorStore.getState().setTabDeleted(item.path, true)
    } catch(e) { console.error(e); toast.error('Failed to delete') }
  }

  return {
    /** Inline create input — state plus its key handling. */
    creating, newName, setNewName, newInputRef, onCreateKeyDown, startCreate,
    /** Inline rename input. */
    renaming, renameRef, onRenameKeyDown, startRename,
    /** Create target folder, for the tree's own row clicks. */
    currentFolder, setCurrentFolder,
    deleteItem,
  }
}
