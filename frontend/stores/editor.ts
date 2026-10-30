import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { invoke } from '../lib/ipc'
import { toast } from 'sonner'
import { undoDepth, redoDepth } from '@tiptap/pm/history'
import { isBinaryPath } from '../utils/fileKind'
import { logger } from '../utils/logger'
import { mapWithConcurrency } from '../utils/concurrency'
import { useSyncStore, contentVersion, isRetryableError, isSyncRecordInScope } from './sync'
import { clearEditorCache, closeCachedEditor } from '../utils/editorCache'
import { splitFrontmatter } from '../utils/frontmatter'

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
  /** The file uses CRLF line endings. The editors only ever see LF (a CRLF
   *  frontmatter fence is not recognised, and BlockNote reads every `\r\n` as a
   *  hard break), so `setContent` normalizes and the save restores them. */
  crlf?: boolean
  /** Content hash of the disk bytes this tab's edit branched from. `null` when
   *  the file did not exist at load time (a new note). The backend rejects a
   *  write whose baseline no longer matches disk, which is what makes an edit
   *  safe against an external change instead of a blind overwrite. */
  baseVersion?: string | null
  /** Read-only presentation for this tab: `'diff'` renders the Changes panel's
   *  inline diff in the editor surface instead of the WYSIWYG/source editor.
   *  Undefined is the normal editor. Set by openDiff, cleared by openFile so the
   *  same path always reopens as an editable tab. */
  view?: 'diff'
  /** Whether the diff compares against HEAD (staged) — `'diff'` view only. */
  diffStaged?: boolean
  /** Path as git status reports it, for `git_diff_file` — the C-quoted form when
   *  the name needed quoting, while `path` stays the real vault path. */
  diffPath?: string
}

export type EditMode = 'editor' | 'code'

interface EditorState {
  tabs: Tab[]; activeTab: string | null; editMode: EditMode
  blockEditor: any | null
  canUndo: boolean; canRedo: boolean
  _flushEditor: (() => void | Promise<void>) | null

  setBlockEditor: (e: any) => void
  setUndoRedoState: () => void
  flushEditor: () => Promise<void>
  setFlushEditor: (fn: (() => void | Promise<void>) | null) => void
  undo: () => void
  redo: () => void
  /** createIfMissing: Obsidian-style — a wiki link to a missing note creates it.
   *  onMissing: a missing file is expected (diffs from the Changes panel) —
   *  `'deleted'` marks the tab deleted, `'quiet'` leaves it empty; neither toasts. */
  openFile: (path: string, name: string, createIfMissing?: boolean, onMissing?: 'deleted' | 'quiet') => Promise<void>
  /** Open a file as a read-only diff in the editor surface (Changes panel).
   *  `staged` picks the range: index-vs-HEAD when true, worktree-vs-index when false.
   *  `deleted`: git status reports a deletion, so a missing file marks the tab
   *  deleted — a failed read alone cannot tell.
   *  `gitPath`: the status form of `path` (quoted when the name needed it), used
   *  for the diff; `path` is the decoded vault path the tab is keyed by. */
  openDiff: (path: string, name: string, staged: boolean, deleted?: boolean, gitPath?: string) => Promise<void>
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


/** `file_version` answers a bare string on desktop but a JSON-encoded one on the
 *  web server (`"\"<hash>\""`, or `"null"` for a missing file), whose command
 *  results are JSON text. A baseline kept with its quotes never matches the
 *  backend's hash, so the first save after reading it was always a conflict. */
const normalizeVersion = (value: string | null): string | null => {
  if (value === null) return null
  let current = value
  for (let i = 0; i < 2; i++) {
    try {
      const parsed = JSON.parse(current)
      if (parsed === null) return null
      if (typeof parsed !== 'string') break
      current = parsed
    } catch { break }
  }
  return current
}
/** The on-disk version of `path` as a bare hash, or null when unknown. Every
 *  baseline read goes through here so both runtimes agree on its shape. */
const readFileVersion = (path: string) =>
  invoke<string | null>('file_version', { path }).then(normalizeVersion, () => null)
/** Read a note together with the version of exactly those bytes.
 *
 *  Text and version are two calls. A write landing between them paired the old
 *  text with the new version, so the next save matched the baseline and
 *  silently overwrote that write. The common case costs nothing extra: the hash
 *  of the text read equals the version. Otherwise — a write in between, or bytes
 *  that are not valid UTF-8, whose lossy text hashes differently — the note is
 *  read again, and the version is trusted only when the text did not change
 *  around it. A note that keeps changing gets no version: the caller then hashes
 *  the text it shows, so a save against newer bytes conflicts. */
const readWithVersion = async (path: string): Promise<{ raw: string; version: string | null }> => {
  let raw = await invoke<string>('read_file', { path })
  for (let attempt = 0; attempt < 3; attempt++) {
    const version = await readFileVersion(path)
    if (version === null || version === contentVersion(raw)) return { raw, version }
    const again = await invoke<string>('read_file', { path })
    if (again === raw) return { raw, version }
    raw = again
  }
  return { raw, version: null }
}
const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Concurrent tab reloads after a branch switch (see `reloadAllTabs`). */
const TAB_RELOAD_CONCURRENCY = 6

export const useEditorStore = create<EditorState>()(
  persist(
    (set, get) => {
  /** Disk content for a tab carrying WYSIWYG/code edits (frontmatter kept raw),
   *  in the file's own line endings.
   *
   *  The body's trailing blank lines are dropped and the file's own ending is put
   *  back: one final newline when the file had one (or is new), none when it did
   *  not — so a save changes the lines that were edited and never the last-line
   *  marker git reports as "No newline at end of file". Leading blank lines are
   *  kept: the frontmatter owns the ones after it (see splitFrontmatter), and a
   *  file with none is the author's own layout.
   *
   *  A file that is only frontmatter can end at the closing fence with no newline;
   *  the body then needs one to start on its own line, or its first line would be
   *  glued to the fence and the frontmatter would stop closing. */
  const tabDiskContent = (tab: Tab) => {
    const body = tab.editedContent!.replace(/\n+$/, '')
    const hadFinalNewline = !tab.content || /\n$/.test(tab.content)
    const joint = tab.frontmatter && body && !tab.frontmatter.endsWith('\n') ? '\n' : ''
    const content = tab.frontmatter + joint + body + (body && hadFinalNewline ? '\n' : '')
    return tab.crlf ? content.replace(/\n/g, '\r\n') : content
  }

  /** After a write of `content` lands (or is queued), the tab is clean only if
   *  nothing was typed meanwhile: code mode edits the store directly, so a
   *  keystroke during the round trip is already in `editedContent` and must stay
   *  dirty — and be saved — rather than be marked written. */
  const settleWrite = (path: string, content: string, patch: Partial<Tab> = {}) => {
    let stillDirty = false
    set({
      tabs: get().tabs.map(t => {
        if (t.path !== path) return t
        stillDirty = t.editedContent !== null && tabDiskContent(t) !== content
        return { ...t, ...patch, content, dirty: stillDirty }
      }),
    })
    if (stillDirty) scheduleAutoSave(path)
  }

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
        settleWrite(tab.path, content)
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

    settleWrite(tab.path, content, { baseVersion: outcome.version })
  }

  const scheduleAutoSave = (path: string) => {
    const t = autoSaveTimers.get(path)
    if (t) clearTimeout(t)
    autoSaveTimers.set(path, setTimeout(() => {
      autoSaveTimers.delete(path)
      get().persistAllDirty().catch(() => toast.error('Auto-save failed — check disk access'))
    }, AUTOSAVE_DELAY_MS))
  }
  let flushPromise: Promise<void> | null = null
  return {
  tabs: [], activeTab: null, editMode: 'editor', blockEditor: null, canUndo: false, canRedo: false, _flushEditor: null as (() => void | Promise<void>) | null,
  setBlockEditor: (e) => { set({ blockEditor: e }); if (e) get().setUndoRedoState(); else set({ canUndo: false, canRedo: false }) },
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

  openFile: async (path, name, createIfMissing = false, onMissing) => {
    if (get().activeTab !== path) {
      try { await get().flushEditor() } catch (error) {
        logger.error('editor_exit_failed', { error })
        toast.error('Could not switch files because editor changes could not be serialized.')
        return
      }
    }
    if (get().tabs.find(t => t.path === path)) { set({ activeTab: path, tabs: get().tabs.map(t => t.path === path ? { ...t, view: undefined, diffStaged: undefined, diffPath: undefined } : t) }); return }
    set({ tabs: [...get().tabs, { path, name, content: null, frontmatter: '', editedContent: null, dirty: false, deleted: false, baseVersion: null }], activeTab: path })
    // Binary/image files are previewed via asset URL, never read as UTF-8 text.
    if (isBinaryPath(path)) return
    try {
      // Capture the baseline before the tab can be typed into: the version read
      // here is what a subsequent save is validated against.
      const { raw, version } = await readWithVersion(path)
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
      if (onMissing && notFound) {
        // Deleted in the working tree: an empty, unsaveable tab is the truth.
        get().setContent(path, '')
        set({ tabs: get().tabs.map(t => t.path === path ? { ...t, baseVersion: null, deleted: onMissing === 'deleted' } : t) })
        return
      }
      console.error(e)
      // Failed read must not leave the tab stuck on "Loading…" — render an
      // empty editor instead, and tell the user why.
      get().setContent(path, '')
      set({ tabs: get().tabs.map(t => t.path === path ? { ...t, baseVersion: null } : t) })
      toast.error(notFound ? 'File not found' : 'Failed to open file')
    }
  },

  openDiff: async (path, name, staged, deleted = false, gitPath = path) => {
    // Reuse the normal open path so tab identity, flushing, and the loaded
    // content all match a regular open — then flag this tab as a diff view.
    // A deletion has no file to read — that is not an error for a diff. Nor is
    // a name that is not valid UTF-8: only its quoted status form addresses it,
    // which git understands and the file commands do not.
    const unaddressable = path === gitPath && gitPath.startsWith('"')
    await get().openFile(path, name, false, deleted ? 'deleted' : unaddressable ? 'quiet' : undefined)
    set({ tabs: get().tabs.map(t => t.path === path ? { ...t, view: 'diff', diffStaged: staged, diffPath: gitPath } : t) })
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
    /** The tab remounts under its new path and builds a fresh editor from the
     *  flushed content. The old instance is bound to the old path (its AI stream,
     *  its snapshot writes), so it is stopped and dropped rather than left in the
     *  cache holding the file's previous identity. */
    for (const path of stale) closeCachedEditor(path, 'file renamed')
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
    }
    /** An inactive tab can be dirty too: it was flushed when it lost focus, but
     *  its autosave may still be pending (or a background AI wrote into it).
     *  Closing cancels that autosave below, so it is saved here first. */
    const tab = get().tabs.find(t => t.path === path)
    if (tab?.editedContent !== null && tab?.dirty && !tab.deleted) {
      try { await saveTabToDisk(tab) } catch (error) {
        logger.error('tab_save_failed', { error, fileName: tab.name })
        toast.error(`Could not save "${tab.name}". The tab was kept open; check disk access and try again.`)
        return
      }
    }
    const currentTabs = get().tabs
    const closingIndex = currentTabs.findIndex(t => t.path === path)
    if (closingIndex === -1) return
    closeCachedEditor(path)
    const autoSaveTimer = autoSaveTimers.get(path)
    if (autoSaveTimer) clearTimeout(autoSaveTimer)
    autoSaveTimers.delete(path)
    const tabs = currentTabs.filter(t => t.path !== path)
    let activeTab = get().activeTab
    if (activeTab === path) {
      // Editor-style close: activate the tab that slides into the closed slot
      // (the neighbour to its right), NOT the most recently opened tab. Closing
      // the last tab has no right neighbour, so fall back to the new last one.
      activeTab = (tabs[closingIndex] ?? tabs[tabs.length - 1])?.path ?? null
    }
    set({ tabs, activeTab })
  },

  closeAllTabs: () => {
    clearEditorCache()
    autoSaveTimers.clear()
    set({ tabs: [], activeTab: null, blockEditor: null, _flushEditor: null, canUndo: false, canRedo: false })
  },

  setContent: (path, fileContent) => {
    /* `content` keeps the disk bytes (the save compares against them); the
       editable parts are LF-only, and the save converts back (tabDiskContent). */
    const crlf = fileContent.includes('\r\n')
    const text = crlf ? fileContent.replace(/\r\n/g, '\n') : fileContent
    const { frontmatter, body } = splitFrontmatter(text)
    set({ tabs: get().tabs.map(t => t.path === path ? { ...t, content: fileContent, frontmatter, editedContent: body, dirty: false, crlf } : t) })
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
        const { raw, version } = await readWithVersion(tab.path)
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

  /** After a branch switch: flush, then re-read every non-dirty text tab.
   *  Reads are independent, so a small fixed fan-out beats a serial loop — a
   *  branch with many open tabs would otherwise pay one round trip at a time.
   *  The cap keeps a large session from flooding IPC. */
  reloadAllTabs: async () => {
    await get().flushEditor()
    const candidates = get().tabs.filter(t => !t.dirty && !isBinaryPath(t.path))
    await mapWithConcurrency(candidates, TAB_RELOAD_CONCURRENCY, async (t) => {
      try {
        const { raw, version } = await readWithVersion(t.path)
        get().setContent(t.path, raw)
        set({ tabs: get().tabs.map(x => x.path === t.path ? { ...x, baseVersion: version ?? contentVersion(raw) } : x) })
        get().setTabDeleted(t.path, false)
      } catch {
        get().setTabDeleted(t.path, true)
      }
    })
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
    const conflict = useSyncStore.getState().conflicts.find(c => c.path === path && isSyncRecordInScope(c))
    if (!conflict) return
    // Prefer the exact bytes captured at conflict time. Re-reading could take yet
    // another writer's version and quietly discard the one the user just chose.
    get().setContent(path, conflict.theirs)
    set({ tabs: get().tabs.map(t => t.path === path ? { ...t, baseVersion: conflict.theirsVersion } : t) })
    useSyncStore.getState().resolveKeepTheirs(path)
  },

  /** Push the local edit over the disk version, then rebase the tab baseline. */
  applyConflictMine: async (path) => {
    const conflict = useSyncStore.getState().conflicts.find(c => c.path === path && isSyncRecordInScope(c))
    if (!conflict) return
    const resolved = await useSyncStore.getState().resolveKeepMine(path)
    if (!resolved) return
    const raw = await readFileVersion(path)
    get().setContent(path, conflict.mine)
    set({ tabs: get().tabs.map(t => t.path === path ? { ...t, baseVersion: raw ?? contentVersion(conflict.mine) } : t) })
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
