import { create } from 'zustand'
import { invoke } from '../lib/ipc'
import { toast } from 'sonner'
import { undoDepth, redoDepth } from '@tiptap/pm/history'
import { isBinaryPath } from '../utils/fileKind'
import { logger } from '../utils/logger'

export interface Tab {
  path: string
  name: string
  /** Full original file content (frontmatter + markdown body). null = not yet loaded. */
  content: string | null
  /** YAML frontmatter */
  frontmatter: string
  /** BlockNote WYSIWYG output (synced only on mode switch) */
  editedContent: string | null
  /** Per-tab dirty flag: true if edits exist that haven't been written to disk */
  dirty: boolean
  /** File was deleted from vault (strikethrough indicator) */
  deleted: boolean
}

export type EditMode = 'editor' | 'code'

interface EditorState {
  tabs: Tab[]; activeTab: string | null; editMode: EditMode
  blockEditor: any | null
  canUndo: boolean; canRedo: boolean
  _flushEditor: (() => void) | null
  setBlockEditor: (e: any) => void
  setUndoRedoState: () => void
  flushEditor: () => void
  setFlushEditor: (fn: (() => void) | null) => void
  undo: () => void
  redo: () => void
  /** createIfMissing: Obsidian-style — a wiki link to a missing note creates it. */
  openFile: (path: string, name: string, createIfMissing?: boolean) => Promise<void>
  switchTab: (path: string) => void
  /** Rename an open file: remaps the tab's path+name so saves, git status and
   *  wiki backlinks keep targeting the NEW path. Flushes first so in-flight WYSIWYG
   *  edits survive the remap (the editor remounts under the new key). */
  renameTab: (fromPath: string, toPath: string) => void
  closeTab: (path: string) => Promise<void>
  closeAllTabs: () => void
  setContent: (path: string, fileContent: string) => void
  setFrontmatter: (path: string, fm: string) => void
  setEditedContent: (path: string, md: string) => void
  setTabDirty: (path: string, dirty: boolean) => void
  setTabDeleted: (path: string, deleted: boolean) => void
  /** Flush the WYSIWYG editor and write every dirty tab to disk (graceful close). */
  persistAllDirty: () => Promise<void>
  /** Re-read open tabs from disk after a branch switch. Dirty tabs are kept
   *  untouched (their in-memory edits stay); files missing on the new branch
   *  are marked deleted. */
  reloadAllTabs: () => Promise<void>
  setEditMode: (mode: EditMode) => void
  toggleEditMode: () => void
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [], activeTab: null, editMode: 'editor', blockEditor: null, canUndo: false, canRedo: false, _flushEditor: null as (() => void) | null,

  setBlockEditor: (e) => { set({ blockEditor: e }); if (e) get().setUndoRedoState(); else set({ canUndo: false, canRedo: false }) },
  /** Read undo/redo availability from the live TipTap editor (resets on replaceBlocks).
   *  BlockNote registers history as a prosemirror plugin (no TipTap undo/redo command),
   *  so availability is read via undoDepth/redoDepth of the history state. */
  setUndoRedoState: () => {
    const state = get().blockEditor?._tiptapEditor?.state
    set({ canUndo: !!state && undoDepth(state) > 0, canRedo: !!state && redoDepth(state) > 0 })
  },
  flushEditor: () => { try { get()._flushEditor?.() } catch {} },
  setFlushEditor: (fn) => { set({ _flushEditor: fn }) },
  undo: () => { try { get().blockEditor?.undo() } catch {}; get().setUndoRedoState() },
  redo: () => { try { get().blockEditor?.redo() } catch {}; get().setUndoRedoState() },
  
  openFile: async (path, name, createIfMissing = false) => {
    if (get().tabs.find(t => t.path === path)) { set({ activeTab: path }); return }
    set({ tabs: [...get().tabs, { path, name, content: null, frontmatter: '', editedContent: null, dirty: false, deleted: false }], activeTab: path })
    // Binary/image files are previewed via asset URL, never read as UTF-8 text.
    if (isBinaryPath(path)) return
    try {
      const raw = await invoke<string>('read_file', { path })
      get().setContent(path, raw)
    } catch (e) {
      const notFound = /no such file|not found|os error 2/i.test(String(e))
      if (createIfMissing && notFound) {
        // Obsidian behavior: opening a wiki link to a missing note creates it.
        try {
          await invoke('write_file', { path, content: '' })
          get().setContent(path, '')
          toast.success(`Created empty note "${name}"`)
          return
        } catch { /* fall through to the error state below */ }
      }
      console.error(e)
      // Failed read must not leave the tab stuck on "Loading…" — render an
      // empty editor instead, and tell the user why.
      get().setContent(path, '')
      toast.error(notFound ? 'File not found' : 'Failed to open file')
    }
  },
  
  switchTab: (path) => {
    /** Keep-alive: leaving editors are NOT unmounted/destroyed (instance cache),
     *  so the old unmount-flush no longer fires — flush the OUTGOING editor
     *  explicitly before switching (its state must land in the store first). */
    if (get().activeTab !== path) get().flushEditor()
    set({ activeTab: path })
  },

  renameTab: (fromPath, toPath) => {
    if (!get().tabs.some(t => t.path === fromPath)) return
    /** Flush the renamed editor now: it remounts under the new path key
     *  (WysiwygEditor key={path}) and there is no unmount-flush anymore, so
     *  unsaved edits must be captured before the remap. */
    if (get().activeTab === fromPath) get().flushEditor()
    /** The target is already open: the renamed file IS that tab — drop the
     *  stale old-path tab instead of creating a duplicate path. */
    if (get().tabs.some(t => t.path === toPath && t.path !== fromPath)) {
      set({ tabs: get().tabs.filter(t => t.path !== fromPath), activeTab: get().activeTab === fromPath ? toPath : get().activeTab })
      return
    }
    const name = toPath.split('/').pop() || toPath
    const tabs = get().tabs.map(t => t.path === fromPath ? { ...t, path: toPath, name } : t)
    set({ tabs, activeTab: get().activeTab === fromPath ? toPath : get().activeTab })
  },
  
  closeTab: async (path) => {
    if (get().activeTab === path) {
      get().flushEditor()
      const tab = get().tabs.find(t => t.path === path)
      if (tab?.editedContent !== null && tab?.dirty && !tab.deleted) {
        const content = tab.frontmatter + tab.editedContent.replace(/^\n+/, '').replace(/\n+$/, '')
        try { await invoke('write_file', { path, content }) } catch (error) {
          logger.error('tab_save_failed', { error, fileName: tab.name })
          toast.error(`Could not save "${tab.name}". The tab was kept open; check disk access and try again.`)
          return
        }
      }
    }
    const tabs = get().tabs.filter(t => t.path !== path)
    let activeTab = get().activeTab
    if (activeTab === path) activeTab = tabs.length > 0 ? tabs[tabs.length - 1].path : null
    set({ tabs, activeTab })
  },

  closeAllTabs: () => {
    set({ tabs: [], activeTab: null, blockEditor: null, _flushEditor: null, canUndo: false, canRedo: false })
  },
  
  setContent: (path, fileContent) => {
    const fm = fileContent.match(/^---[\s\S]*?\n---(?:\n|$)/)
    set({ tabs: get().tabs.map(t => t.path === path ? { ...t, content: fileContent, frontmatter: fm ? fm[0] : '', dirty: false } : t) })
  },
  
  setFrontmatter: (path, fm) => {
    set({ tabs: get().tabs.map(t => t.path === path ? { ...t, frontmatter: fm } : t) })
  },
  setEditedContent: (path, md) => {
    set({ tabs: get().tabs.map(t => t.path === path ? { ...t, editedContent: md } : t) })
  },
  setTabDirty: (path, dirty) => { set({ tabs: get().tabs.map(t => t.path === path ? { ...t, dirty } : t) }) },
  setTabDeleted: (path, deleted) => { set({ tabs: get().tabs.map(t => (t.path === path || t.path.startsWith(path + '/')) ? { ...t, deleted } : t) }) },

  /** After a branch switch: flush, then re-read every non-dirty text tab. */
  reloadAllTabs: async () => {
    get().flushEditor()
    const tabs = get().tabs
    for (const t of tabs) {
      if (t.dirty || isBinaryPath(t.path)) continue
      try {
        const raw = await invoke<string>('read_file', { path: t.path })
        get().setContent(t.path, raw)
        get().setTabDeleted(t.path, false)
      } catch {
        get().setTabDeleted(t.path, true)
      }
    }
  },

  /** Flush WYSIWYG then write every dirty tab to disk — used on app close. */
  persistAllDirty: async () => {
    get().flushEditor()
    for (const tab of get().tabs) {
      if (tab.dirty && tab.editedContent !== null && !tab.deleted) {
        const content = tab.frontmatter + tab.editedContent.replace(/^\n+/, '').replace(/\n+$/, '')
        try { await invoke('write_file', { path: tab.path, content }) } catch (error) {
          logger.error('dirty_file_save_failed', { error, fileName: tab.name })
          throw new Error(`Could not save ${tab.name}`, { cause: error })
        }
      }
    }
  },
  
  setEditMode: (mode) => { set({ editMode: mode }) },
  /** Toggle editor mode; flush Editor → store BEFORE switching to Code so edits are not lost. */
  toggleEditMode: () => {
    const { editMode, flushEditor } = get()
    if (editMode === 'editor') flushEditor()
    set({ editMode: editMode === 'editor' ? 'code' : 'editor' })
  },
}))
