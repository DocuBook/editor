import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { invoke, openDir } from '../lib/ipc'
import { toast } from 'sonner'
import { useEditorStore } from './editor'
import { logger } from '../utils/logger'

/** File or directory info from the vault tree. */
export interface FileInfo { path: string; name: string; type: string; depth?: number; isExpanded?: boolean }

/** A previously-opened vault (for the recent list + dialog default path). */
export interface RecentVault { path: string; name: string; parent: string }

/** Internal vault state (not exported). */
interface VaultState {
  name: string; isOpen: boolean; vaultPath: string; recent: RecentVault[]
  tree: FileInfo[]; visibleItems: FileInfo[]; expanded: Record<string, boolean>; childrenCache: Record<string, FileInfo[]>; loading: boolean
  openVault: () => Promise<void>; createVault: (parent: string, name: string) => Promise<void>; cloneVault: (url: string, parent: string) => Promise<void>; closeVault: () => Promise<void>; resumeVault: () => Promise<void>; openRecent: (path: string) => Promise<void>
  loadTree: (subpath?: string) => Promise<void>
  toggleFolder: (item: FileInfo) => Promise<void>; flattenTree: (items: FileInfo[], depth: number) => FileInfo[]
}

/** Zustand store managing vault lifecycle and file tree state. Persists vaultPath + expanded + recent to localStorage. */
export const useVaultStore = create<VaultState>()(
  persist(
    (set, get) => {
      let transitioning = false
      let transitionId = 0
      let treeRequestId = 0
      const folderRequestIds: Record<string, number> = {}
      const emptyTreeState = () => ({ name: '', isOpen: false, vaultPath: '', tree: [], visibleItems: [], expanded: {}, childrenCache: {} })
      const beginTransition = () => {
        if (transitioning || get().loading) return null
        transitioning = true
        const id = ++transitionId
        set({ loading: true })
        return id
      }
      const finishTransition = (id: number) => {
        if (transitionId !== id) return
        transitioning = false
        set({ loading: false })
      }
      const prepareTransition = async (id: number) => {
        if (transitionId !== id) return false
        try {
          await useEditorStore.getState().persistAllDirty()
          if (get().isOpen) await invoke('close_vault')
          useEditorStore.getState().closeAllTabs()
          treeRequestId++
          set({ ...emptyTreeState(), loading: true })
          return true
        } catch (error) {
          logger.error('vault_switch_save_failed', { error })
          toast.error('Vault stayed open because a file could not be saved. Check disk access and try again.')
          transitioning = false
          set({ loading: false })
          return false
        }
      }
      /** Track opened vaults for the recent list (dedupe, newest first, max 5). */
      const pushRecent = (path: string) => {
        const name = path.split('/').pop() || ''
        const parent = path.replace(/\/[^/]*$/, '')
        set({ recent: [{ path, name, parent }, ...get().recent.filter(r => r.path !== path)].slice(0, 5) })
      }
      return {
        name: '', isOpen: false, vaultPath: '', recent: [],
        tree: [], visibleItems: [], expanded: {}, childrenCache: {}, loading: false,

      /** Open a directory picker and load the selected folder as vault. */
      openVault: async () => {
        const id = beginTransition()
        if (id === null) return
        try {
          const path = await openDir({ title: 'Open Vault', defaultPath: get().recent[0]?.parent })
          if (!path) { finishTransition(id); return }
          if (!await prepareTransition(id)) return
          const res = await invoke<string>('open_vault', { path })
          const d = JSON.parse(res)
          if (transitionId !== id) return
          set({ name: d.name, vaultPath: path, isOpen: true, expanded: {} })
          pushRecent(path)
          await get().loadTree()
          finishTransition(id)
        } catch (e) { console.error(e); toast.error('Failed to open vault'); finishTransition(id) }
      },
      /** Create a new vault folder inside parent dir and open it. */
      createVault: async (parent: string, name: string) => {
        const id = beginTransition()
        if (id === null) return
        try {
          if (!await prepareTransition(id)) return
          const res = await invoke<string>('create_vault', { parent, name })
          const d = JSON.parse(res)
          const path = parent.replace(/\/+$/, '') + '/' + name
          if (transitionId !== id) return
          set({ name: d.name, vaultPath: path, isOpen: true, expanded: {} })
          pushRecent(path)
          await get().loadTree()
          finishTransition(id)
        } catch (e) { console.error(e); toast.error('Failed to create vault'); finishTransition(id) }
      },
      /** Clone a remote git repository into parent dir and open it as vault. */
      cloneVault: async (url: string, parent: string) => {
        const id = beginTransition()
        if (id === null) return
        try {
          if (!await prepareTransition(id)) return
          const res = await invoke<string>('git_clone', { url, parent })
          const d = JSON.parse(res)
          if (transitionId !== id) return
          set({ name: d.name, vaultPath: d.path, isOpen: true, expanded: {} })
          pushRecent(d.path)
          await get().loadTree()
          finishTransition(id)
        } catch (e) { finishTransition(id); throw e }
      },
      /** Close vault and reset all state. */
      closeVault: async () => {
        const id = beginTransition()
        if (id === null) return
        if (!await prepareTransition(id)) return
        finishTransition(id)
      },
      /** Open a vault by path (no auto-resume at startup — user picks from welcome screen). */
      openRecent: async (path: string) => {
        const id = beginTransition()
        if (id === null) return
        try {
          if (!await prepareTransition(id)) return
          const res = await invoke<string>('open_vault', { path })
          const d = JSON.parse(res)
          if (transitionId !== id) return
          set({ name: d.name, vaultPath: path, isOpen: true, expanded: {} })
          pushRecent(path)
          await get().loadTree()
          finishTransition(id)
        } catch {
          // Vault can't be reopened (deleted/moved) — drop from recent + clear last vault so welcome shows next time
          set({ vaultPath: '', recent: get().recent.filter(r => r.path !== path) })
          toast.error('Vault not found — removed from recent')
          finishTransition(id)
        }
      },
      /** Auto-resume last vault on startup (restore-on-startup: last session). */
      resumeVault: async () => {
        const { vaultPath } = get()
        if (!vaultPath) return
        await get().openRecent(vaultPath)
      },
      /** Load root tree (or subtree) from Rust backend. Re-fetches expanded folders. */
      loadTree: async (subpath = '') => {
        const requestId = ++treeRequestId
        const vaultPath = get().vaultPath
        const treeStr = await invoke<string>('list_tree', { subpath })
        if (requestId !== treeRequestId || get().vaultPath !== vaultPath) return
        const tree = JSON.parse(treeStr)
        const expanded = get().expanded
        const cc: Record<string, FileInfo[]> = {}
        for (const folderPath of Object.keys(expanded)) {
          if (expanded[folderPath]) {
            try {
              const s = await invoke<string>('list_tree', { subpath: folderPath })
              if (requestId !== treeRequestId || get().vaultPath !== vaultPath) return
              cc[folderPath] = JSON.parse(s)
            } catch {}
          }
        }
        if (requestId !== treeRequestId || get().vaultPath !== vaultPath) return
        set({ tree, childrenCache: cc })
        set({ visibleItems: get().flattenTree(tree, 0) })
      },
      /** Toggle folder expansion, fetching children on first open. */
      toggleFolder: async (item: FileInfo) => {
        const requestId = (folderRequestIds[item.path] || 0) + 1
        folderRequestIds[item.path] = requestId
        const treeVersion = treeRequestId
        const vaultPath = get().vaultPath
        const expanded = { ...get().expanded }
        if (expanded[item.path]) {
          delete expanded[item.path]
          set({ expanded })
          set({ visibleItems: get().flattenTree(get().tree, 0) })
          return
        }
        expanded[item.path] = true
        set({ expanded })
        set({ visibleItems: get().flattenTree(get().tree, 0) })
        if (!get().childrenCache[item.path]) {
          try {
            const s = await invoke<string>('list_tree', { subpath: item.path })
            if (folderRequestIds[item.path] !== requestId || treeRequestId !== treeVersion || get().vaultPath !== vaultPath || !get().expanded[item.path]) return
            set({ childrenCache: { ...get().childrenCache, [item.path]: JSON.parse(s) } })
          } catch { return }
        }
        if (folderRequestIds[item.path] !== requestId || treeRequestId !== treeVersion || get().vaultPath !== vaultPath) return
        set({ visibleItems: get().flattenTree(get().tree, 0) })
      },
      /** Flatten nested tree into depth-annotated visible list with expansion state. */
      flattenTree: (items, depth) => {
        const expanded = get().expanded; const cc = get().childrenCache; let r: FileInfo[] = []
        for (const item of items) {
          const isExpanded = expanded[item.path] || false
          r.push({ ...item, depth, isExpanded })
          if (item.type === '1' && isExpanded && cc[item.path]) r = r.concat(get().flattenTree(cc[item.path], depth + 1))
        }
        return r
      },
      }
    },
    {
      name: 'docubook:vault',
      partialize: (state) => ({ vaultPath: state.vaultPath, expanded: state.expanded, recent: state.recent }),
      onRehydrateStorage: () => (state) => { state?.resumeVault?.() },
    }
  )
)
