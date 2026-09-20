import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { invoke } from '../lib/ipc'
import { toast } from 'sonner'
import { undoDepth, redoDepth } from '@tiptap/pm/history'
import { isBinaryPath } from '../utils/fileKind'
import { logger } from '../utils/logger'
import { useSyncStore, contentVersion, isRetryableError } from './sync'

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
  /** Content hash of the disk bytes this tab's edit branched from. `null` when
   *  the file did not exist at load time (a new note). The backend rejects a
   *  write whose baseline no longer matches disk, which is what makes an edit
   *  safe against an external change instead of a blind overwrite. */
  baseVersion?: string | null
}

export type EditMode = 'editor' | 'code'

interface EditorState {
  tabs: Tab[]; activeTab: string | null; editMode: EditMode
  blockEditor: any | null
  canUndo: boolean; canRedo: boolean
  _flushEditor: (() => void | Promise<void>) | null
  /** True while the rust-ai extension is streaming — autosave must not persist a
   *  half-written document (guard 2). Set by WysiwygEditor on AI state change. */
  _aiWriting: boolean
  setAiWriting: (writing: boolean) => void
  setBlockEditor: (e: any) => void
  setUndoRedoState: () => void
  flushEditor: () => Promise<void>
  setFlushEditor: (fn: (() => void | Promise<void>) | null) => void
  undo: () => void
  redo: () => void
  /** createIfMissing: Obsidian-style — a wiki link to a missing note creates it. */
  openFile: (path: string, name: string, createIfMissing?: boolean) => Promise<void>
  switchTab: (path: string) => Promise<void>
  /** Rename an open file: remaps the tab's path+name so saves, git status and
   *  wiki backlinks keep targeting the NEW path. Flushes first so in-flight WYSIWYG
   *  edits survive the remap (the editor remounts under the new key). */
  renameTab: (fromPath: string, toPath: string) => Promise<void>
  closeTab: (path: string) => Promise<void>
  closeAllTabs: () => void
  setContent: (path: string, fileContent: string) => void
  setFrontmatter: (path: string, fm: string) => void
  setEditedContent: (path: string, md: string) => void
  setTabDirty: (path: string, dirty: boolean) => void
  setTabDeleted: (path: string, deleted: boolean) => void
  /** Flush the WYSIWYG editor and write every dirty tab to disk (graceful close). */
  persistAllDirty: () => Promise<void>
  /** Adopt the on-disk content for a conflicted tab, dropping the local edit. */
  applyConflictTheirs: (path: string) => Promise<void>
  /** Keep the local edit for a conflicted tab (overwrites disk) and rebase. */
  applyConflictMine: (path: string) => Promise<void>
  /** Save the local edit beside the original, leaving disk content intact. */
  applyConflictKeepBoth: (path: string) => Promise<void>
  /** Rebase a tab only when its queued content is still the current in-memory edit. */
  rebaseQueuedWrite: (path: string, write: { content: string; contentVersion: string }) => void
  /** Re-read open tabs from disk after a branch switch. Dirty tabs are kept
   *  untouched (their in-memory edits stay); files missing on the new branch
   *  are marked deleted. */
  reloadAllTabs: () => Promise<void>
  /** Rehydrate the persisted tab identities from disk after the vault resumes. */
  restoreSessionTabs: () => Promise<void>
  setEditMode: (mode: EditMode) => void
  toggleEditMode: () => Promise<void>
}

/** Autosave debounce — one timer per tab path; typing in either mode (WYSIWYG
 *  onChange or code textarea) restarts the countdown via setTabDirty(true). */
const AUTOSAVE_DELAY_MS = 2000


const normalizeVersion = (value: string | null): string | null => {
  if (value === null) return null
  let current = value
  for (let i = 0; i < 2; i++) {
    try {
      const parsed = JSON.parse(current)
      if (typeof parsed !== 'string') break
      current = parsed
    } catch { break }
  }
  return current
}
const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()

export const useEditorStore = create<EditorState>()(
  persist(
    (set, get) => {
  /** Disk content for a tab carrying WYSIWYG/code edits (frontmatter kept raw). */
  const tabDiskContent = (tab: Tab) => tab.frontmatter + tab.editedContent!.replace(/^\n+/, '').replace(/\n+$/, '')

  /**
   * Write a tab through the versioned guard.
   *
   * Outcomes:
   *  - written   → baseline rebased, tab marked clean.
   *  - conflict  → disk changed under us. The edit is handed to the sync store
   *                as a conflict and the tab stays dirty; nothing is overwritten.
   *  - unreachable backend → the write is queued durably and the tab is marked
   *                clean, because the edit now lives in a queue that survives a
   *                reload. Leaving it dirty would only re-queue it on every
   *                autosave tick.
   *  - permanent failure (bad path, permissions) → rethrown so the caller can
   *                report it; retrying forever would be pointless.
   */
  const saveTabToDisk = async (tab: Tab) => {
    const content = tabDiskContent(tab)
    if (content === tab.content) { get().setTabDirty(tab.path, false); return }

    const baseVersion = tab.baseVersion ?? null
    let raw: string
    try {
      raw = await invoke<string>('write_file_checked', { path: tab.path, content, baseVersion })
    } catch (error) {
      if (isRetryableError(error)) {
        useSyncStore.getState().enqueue({ path: tab.path, content, baseVersion })
        set({ tabs: get().tabs.map(t => t.path === tab.path ? { ...t, content, dirty: false } : t) })
        logger.warn('write_queued_offline', { path: tab.path })
        return
      }
      throw error
    }

    const outcome = JSON.parse(raw) as
      | { status: 'written'; version: string }
      | { status: 'conflict'; disk: string; version: string }

    if (outcome.status === 'conflict') {
      // Preserve BOTH sides: the user's edit lives in the conflict record and the
      // winner stays on disk untouched.
      useSyncStore.getState().addConflict({
        path: tab.path,
        mine: content,
        theirs: outcome.disk,
        theirsVersion: outcome.version,
        baseContent: tab.content,
      })
      logger.warn('write_conflict', { path: tab.path })
      return
    }

    set({
      tabs: get().tabs.map(t => t.path === tab.path
        ? { ...t, content, dirty: false, baseVersion: outcome.version }
        : t),
    })
  }

  const scheduleAutoSave = (path: string) => {
    const t = autoSaveTimers.get(path)
    if (t) clearTimeout(t)
    autoSaveTimers.set(path, setTimeout(() => {
      autoSaveTimers.delete(path)
      const s = get()
      if (s._aiWriting) return
      s.persistAllDirty().catch(() => toast.error('Auto-save failed — check disk access'))
    }, AUTOSAVE_DELAY_MS))
  }
  let flushPromise: Promise<void> | null = null
  return {
  tabs: [], activeTab: null, editMode: 'editor', blockEditor: null, canUndo: false, canRedo: false, _flushEditor: null as (() => void | Promise<void>) | null, _aiWriting: false,
  setBlockEditor: (e) => { set({ blockEditor: e }); if (e) get().setUndoRedoState(); else set({ canUndo: false, canRedo: false }) },
  setAiWriting: (writing) => { set({ _aiWriting: writing }) },
  setUndoRedoState: () => {
    const state = get().blockEditor?.prosemirrorState
    set({ canUndo: !!state && undoDepth(state) > 0, canRedo: !!state && redoDepth(state) > 0 })
  },
  flushEditor: () => {
    if (!flushPromise) {
      flushPromise = Promise.resolve().then(() => get()._flushEditor?.()).then(() => undefined).finally(() => { flushPromise = null })
    }
    return flushPromise
  },
  setFlushEditor: (fn) => { set({ _flushEditor: fn }) },
  undo: () => { try { get().blockEditor?.undo() } catch {}; get().setUndoRedoState() },
  redo: () => { try { get().blockEditor?.redo() } catch {}; get().setUndoRedoState() },

  openFile: async (path, name, createIfMissing = false) => {
    if (get().activeTab !== path) {
      try { await get().flushEditor() } catch (error) {
        logger.error('editor_exit_failed', { error })
        toast.error('Could not switch files because editor changes could not be serialized.')
        return
      }
    }
    if (get().tabs.find(t => t.path === path)) { set({ activeTab: path }); return }
    set({ tabs: [...get().tabs, { path, name, content: null, frontmatter: '', editedContent: null, dirty: false, deleted: false, baseVersion: null }], activeTab: path })
    // Binary/image files are previewed via asset URL, never read as UTF-8 text.
    if (isBinaryPath(path)) return
    try {
      const raw = await invoke<string>('read_file', { path })
      // Capture the baseline before the tab can be typed into: the version read
      // here is what a subsequent save is validated against.
      const version = normalizeVersion(await invoke<string | null>('file_version', { path }).catch(() => null))
      get().setContent(path, raw)
      set({ tabs: get().tabs.map(t => t.path === path ? { ...t, baseVersion: version ?? contentVersion(raw) } : t) })
    } catch (e) {
      const notFound = /no such file|not found|os error 2/i.test(String(e))
      if (createIfMissing && notFound) {
        // Obsidian behavior: opening a wiki link to a missing note creates it.
        try {
          const created = await invoke<string>('write_file_checked', { path, content: '', baseVersion: null })
          const outcome = JSON.parse(created) as { status: string; version?: string }
          get().setContent(path, '')
          set({ tabs: get().tabs.map(t => t.path === path ? { ...t, baseVersion: outcome.version ?? contentVersion('') } : t) })
          toast.success(`Created empty note "${name}"`)
          return
        } catch { /* fall through to the error state below */ }
      }
      console.error(e)
      // Failed read must not leave the tab stuck on "Loading…" — render an
      // empty editor instead, and tell the user why.
      get().setContent(path, '')
      set({ tabs: get().tabs.map(t => t.path === path ? { ...t, baseVersion: null } : t) })
      toast.error(notFound ? 'File not found' : 'Failed to open file')
    }
  },

  switchTab: async (path) => {
    if (get().activeTab === path) return
    try { await get().flushEditor() } catch (error) {
      logger.error('editor_exit_failed', { error })
      toast.error('Could not switch tabs because editor changes could not be serialized.')
      return
    }
    set({ activeTab: path })
  },

  renameTab: async (fromPath, toPath) => {

    const prefix = fromPath + '/'
    const affected = get().tabs.filter(t => t.path === fromPath || t.path.startsWith(prefix))
    if (affected.length === 0) return
    if (affected.some(t => t.path === get().activeTab)) await get().flushEditor()
    const remap = (path: string) => (path === fromPath ? toPath : toPath + '/' + path.slice(prefix.length))
    const stale = new Set(affected.map(t => t.path))
    const taken = new Set(get().tabs.filter(t => !stale.has(t.path)).map(t => t.path))
    const tabs = get().tabs.flatMap(t => {
      if (!stale.has(t.path)) return [t]
      const newPath = remap(t.path)
      if (taken.has(newPath)) return [] // collision: keep the already-open new-path tab
      return [{ ...t, path: newPath, name: newPath.split('/').pop() || newPath }]
    })
    const activeTab = get().activeTab
    let nextActive = activeTab
    if (activeTab !== null && stale.has(activeTab)) {
      const remapped = remap(activeTab)
      nextActive = tabs.some(t => t.path === remapped) ? remapped : (tabs[tabs.length - 1]?.path ?? null)
    }
    set({ tabs, activeTab: nextActive })
  },

  closeTab: async (path) => {
    if (get().activeTab === path) {
      try { await get().flushEditor() } catch (error) {
        logger.error('editor_exit_failed', { error })
        toast.error('Could not close the tab because editor changes could not be serialized.')
        return
      }
      const tab = get().tabs.find(t => t.path === path)
      if (tab?.editedContent !== null && tab?.dirty && !tab.deleted) {
        try { await saveTabToDisk(tab) } catch (error) {
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
    autoSaveTimers.clear()
    set({ tabs: [], activeTab: null, blockEditor: null, _flushEditor: null, canUndo: false, canRedo: false })
  },

  setContent: (path, fileContent) => {
    const fm = fileContent.match(/^---[\s\S]*?\n---(?:\n|$)/)
    const body = fm ? fileContent.slice(fm[0].length) : fileContent
    set({ tabs: get().tabs.map(t => t.path === path ? { ...t, content: fileContent, frontmatter: fm ? fm[0] : '', editedContent: body, dirty: false } : t) })
  },
  rebaseQueuedWrite: (path, write) => {
    set({ tabs: get().tabs.map(t => {
      if (t.path !== path || t.content !== write.content) return t
      return { ...t, baseVersion: write.contentVersion }
    }) })
  },

  setFrontmatter: (path, fm) => {
    set({ tabs: get().tabs.map(t => t.path === path ? { ...t, frontmatter: fm } : t) })
  },
  setEditedContent: (path, md) => {
    set({ tabs: get().tabs.map(t => t.path === path ? { ...t, editedContent: md } : t) })
  },
  setTabDirty: (path, dirty) => {
    set({ tabs: get().tabs.map(t => t.path === path ? { ...t, dirty } : t) })
    if (dirty) scheduleAutoSave(path)
  },
  setTabDeleted: (path, deleted) => { set({ tabs: get().tabs.map(t => (t.path === path || t.path.startsWith(path + '/')) ? { ...t, deleted } : t) }) },

  /** Re-read persisted tab identities after the vault has resumed. */
  restoreSessionTabs: async () => {
    for (const tab of [...get().tabs]) {
      if (isBinaryPath(tab.path)) continue
      try {
        const raw = await invoke<string>('read_file', { path: tab.path })
        const version = await invoke<string | null>('file_version', { path: tab.path }).catch(() => null)
        get().setContent(tab.path, raw)
        set({ tabs: get().tabs.map(t => t.path === tab.path ? { ...t, baseVersion: version ?? contentVersion(raw) } : t) })
      } catch (error) {
        const notFound = /no such file|not found|os error 2/i.test(String(error))
        if (notFound) {
          // A file removed while the app was closed should not reappear as a blank tab.
          await get().closeTab(tab.path)
        } else {
          // Keep the session identity for transient permission/IPC/backend errors;
          // a failed restore must not permanently erase the user's tab.
          logger.error('restored_tab_read_failed', { error, fileName: tab.name })
          toast.error(`Failed to restore "${tab.name}"`)
        }
      }
    }
  },

  /** After a branch switch: flush, then re-read every non-dirty text tab. */
  reloadAllTabs: async () => {
    await get().flushEditor()
    const tabs = get().tabs
    for (const t of tabs) {
      if (t.dirty || isBinaryPath(t.path)) continue
      try {
        const raw = await invoke<string>('read_file', { path: t.path })
        const version = await invoke<string | null>('file_version', { path: t.path }).catch(() => null)
        get().setContent(t.path, raw)
        set({ tabs: get().tabs.map(x => x.path === t.path ? { ...x, baseVersion: version ?? contentVersion(raw) } : x) })
        get().setTabDeleted(t.path, false)
      } catch {
        get().setTabDeleted(t.path, true)
      }
    }
  },

  /** Flush WYSIWYG then write every dirty tab to disk — used on app close. */
  persistAllDirty: async () => {
    await get().flushEditor()
    for (const tab of get().tabs) {
      if (tab.dirty && tab.editedContent !== null && !tab.deleted) {
        try { await saveTabToDisk(tab) } catch (error) {
          logger.error('dirty_file_save_failed', { error, fileName: tab.name })
          throw new Error(`Could not save ${tab.name}`, { cause: error })
        }
      }
    }
  },

  /** Take the disk version as the truth: reload the tab from what won on disk. */
  applyConflictTheirs: async (path) => {
    const conflict = useSyncStore.getState().conflicts.find(c => c.path === path)
    if (!conflict) return
    // Prefer the exact bytes captured at conflict time. Re-reading could take yet
    // another writer's version and quietly discard the one the user just chose.
    get().setContent(path, conflict.theirs)
    set({ tabs: get().tabs.map(t => t.path === path ? { ...t, baseVersion: conflict.theirsVersion } : t) })
    useSyncStore.getState().resolveKeepTheirs(path)
  },

  /** Push the local edit over the disk version, then rebase the tab baseline. */
  applyConflictMine: async (path) => {
    const conflict = useSyncStore.getState().conflicts.find(c => c.path === path)
    if (!conflict) return
    const resolved = await useSyncStore.getState().resolveKeepMine(path)
    if (!resolved) return
    const raw = normalizeVersion(await invoke<string | null>('file_version', { path }).catch(() => null))
    get().setContent(path, conflict.mine)
    set({ tabs: get().tabs.map(t => t.path === path ? { ...t, baseVersion: raw ?? contentVersion(conflict.mine) } : t) })
  },

  /** Keep both: write the local edit to a companion file, disk keeps its content. */
  applyConflictKeepBoth: async (path) => {
    const conflict = useSyncStore.getState().conflicts.find(c => c.path === path)
    if (!conflict) return
    const copyPath = await useSyncStore.getState().resolveKeepBoth(path)
    if (!copyPath) return
    // The original tab now tracks the disk version; the local edit lives on in
    // the companion note, so the tab is no longer dirty against this file.
    get().setContent(path, conflict.theirs)
    set({ tabs: get().tabs.map(t => t.path === path ? { ...t, baseVersion: conflict.theirsVersion } : t) })
    toast.success(`Kept your version as "${copyPath.split('/').pop()}"`)
  },

  setEditMode: (mode) => { set({ editMode: mode }) },
  /** Toggle editor mode; flush Editor → store BEFORE switching to Code so edits are not lost. */
  toggleEditMode: async () => {
    const { editMode, flushEditor } = get()
    if (editMode === 'editor') {
      try { await flushEditor() } catch (error) {
        logger.error('editor_exit_failed', { error })
        toast.error('Could not switch modes because editor changes could not be serialized.')
        return
      }
    }
    set({ editMode: editMode === 'editor' ? 'code' : 'editor' })
    /** Mode switch is an app-layer save point (like close tab): the disk then
     *  holds exactly the raw markdown shown in the other mode, so git commit
     *  (which ships the working tree) never sends stale content. */
    const tab = get().tabs.find(t => t.path === get().activeTab)
    if (tab?.editedContent !== null && tab?.dirty && !tab.deleted) {
      saveTabToDisk(tab).catch(e => {
        console.error('mode-switch save failed:', e)
        toast.error(`Could not save "${tab.name}". Changes stay in the editor.`)
      })
    }
  },
      }
    },
    {
      name: 'docubook:editor-session',
      partialize: (state) => ({
        tabs: state.tabs.map(({ path, name }) => ({ path, name })),
        activeTab: state.activeTab,
        editMode: state.editMode,
      }),
    },
  ),
)
