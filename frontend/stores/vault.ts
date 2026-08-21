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
        try {
          const path = await openDir({ title: 'Open Vault', defaultPath: get().recent[0]?.parent })
          if (!path) return
          set({ loading: true })
          const res = await invoke<string>('open_vault', { path })
          const d = JSON.parse(res)
          set({ name: d.name, vaultPath: path, isOpen: true, expanded: {} })
          pushRecent(path)
          await get().loadTree()
          set({ loading: false })
        } catch (e) { console.error(e); toast.error('Failed to open vault'); set({ loading: false }) }
      },
      /** Create a new vault folder inside parent dir and open it. */
      createVault: async (parent: string, name: string) => {
        try {
          const res = await invoke<string>('create_vault', { parent, name })
          const d = JSON.parse(res)
          set({ name: d.name, vaultPath: parent.replace(/\/+$/, '') + '/' + name, isOpen: true, expanded: {} })
          pushRecent(parent.replace(/\/+$/, '') + '/' + name)
          await get().loadTree()
        } catch (e) { console.error(e); toast.error('Failed to create vault') }
      },
      /** Clone a remote git repository into parent dir and open it as vault. */
      cloneVault: async (url: string, parent: string) => {
        set({ loading: true })
        try {
          const res = await invoke<string>('git_clone', { url, parent })
          const d = JSON.parse(res)
          set({ name: d.name, vaultPath: d.path, isOpen: true, expanded: {} })
          pushRecent(d.path)
          await get().loadTree()
        } catch (e) { throw e } finally { set({ loading: false }) }
      },
      /** Close vault and reset all state. */
      closeVault: async () => {
        try { await useEditorStore.getState().persistAllDirty() } catch (error) {
          logger.error('vault_close_save_failed', { error })
          toast.error('Vault stayed open because a file could not be saved. Check disk access and try again.')
          return
        }
        await invoke('close_vault')
        useEditorStore.getState().closeAllTabs()
        set({ name: '', isOpen: false, vaultPath: '', tree: [], visibleItems: [], expanded: {}, childrenCache: {} })
      },
      /** Open a vault by path (no auto-resume at startup — user picks from welcome screen). */
      openRecent: async (path: string) => {
        set({ loading: true })
        try {
          const res = await invoke<string>('open_vault', { path })
          const d = JSON.parse(res)
          set({ name: d.name, vaultPath: path, isOpen: true, expanded: get().expanded })
          pushRecent(path)
          await get().loadTree()
        } catch {
          // Vault can't be reopened (deleted/moved) — drop from recent + clear last vault so welcome shows next time
          set({ vaultPath: '', recent: get().recent.filter(r => r.path !== path) })
          toast.error('Vault not found — removed from recent')
        } finally {
          set({ loading: false })
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
        const treeStr = await invoke<string>('list_tree', { subpath })
        const tree = JSON.parse(treeStr)
        set({ tree })
        const expanded = get().expanded
        const cc = { ...get().childrenCache }
        for (const folderPath of Object.keys(expanded)) {
          if (expanded[folderPath]) {
            try { const s = await invoke<string>('list_tree', { subpath: folderPath }); cc[folderPath] = JSON.parse(s) } catch {}
          }
        }
        // Two `set`s ON PURPOSE: zustand applies each synchronously, so the
        // flatten below must read the UPDATED cache (computing visibleItems in
        // the same set that writes childrenCache would flatten stale data and
        // hide newly created/renamed files until the next tree op).
        set({ childrenCache: cc })
        set({ visibleItems: get().flattenTree(tree, 0) })
      },
      /** Toggle folder expansion, fetching children on first open. */
      toggleFolder: async (item: FileInfo) => {
        const expanded = { ...get().expanded }
        if (expanded[item.path]) { delete expanded[item.path] }
        else {
          expanded[item.path] = true
          if (!get().childrenCache[item.path]) {
            const s = await invoke<string>('list_tree', { subpath: item.path })
            set({ childrenCache: { ...get().childrenCache, [item.path]: JSON.parse(s) } })
          }
        }
        set({ expanded })
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
