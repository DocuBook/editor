import { create } from 'zustand'
import { invoke } from '../lib/ipc'
import { toast } from 'sonner'
import { undoDepth, redoDepth } from '@tiptap/pm/history'

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
  closeTab: (path: string) => void
  setContent: (path: string, fileContent: string) => void
  setFrontmatter: (path: string, fm: string) => void
  setEditedContent: (path: string, md: string) => void
  setTabDirty: (path: string, dirty: boolean) => void
  setTabDeleted: (path: string, deleted: boolean) => void
  /** Flush the WYSIWYG editor and write every dirty tab to disk (graceful close). */
  persistAllDirty: () => Promise<void>
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
  
  switchTab: (path) => { set({ activeTab: path }) },
  
  closeTab: async (path) => {
    if (get().activeTab === path) {
      get().flushEditor()
      const tab = get().tabs.find(t => t.path === path)
      if (tab?.editedContent && tab.dirty && !tab.deleted) {
        const content = tab.frontmatter + tab.editedContent.replace(/^\n+/, '').replace(/\n+$/, '')
        try { await invoke('write_file', { path, content }) } catch (e) { console.error(e) }
      }
    }
    const tabs = get().tabs.filter(t => t.path !== path)
    let activeTab = get().activeTab
    if (activeTab === path) activeTab = tabs.length > 0 ? tabs[tabs.length - 1].path : null
    set({ tabs, activeTab })
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
  setTabDeleted: (path, deleted) => { set({ tabs: get().tabs.map(t => t.path === path ? { ...t, deleted } : t) }) },

  /** Flush WYSIWYG then write every dirty tab to disk — used on app close. */
  persistAllDirty: async () => {
    get().flushEditor()
    for (const tab of get().tabs) {
      if (tab.dirty && tab.editedContent && !tab.deleted) {
        const content = tab.frontmatter + tab.editedContent.replace(/^\n+/, '').replace(/\n+$/, '')
        try { await invoke('write_file', { path: tab.path, content }) } catch (e) { console.error('save on close:', e) }
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
