import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'

/** File or directory info from the vault tree. */
export interface FileInfo { path: string; name: string; type: string; depth?: number; isExpanded?: boolean }

/** Internal vault state (not exported). */
interface VaultState {
  name: string; isOpen: boolean; vaultPath: string
  tree: FileInfo[]; visibleItems: FileInfo[]; expanded: Record<string, boolean>; childrenCache: Record<string, FileInfo[]>; loading: boolean
  openVault: () => Promise<void>; closeVault: () => void; resumeVault: () => Promise<void>
  loadTree: (subpath?: string) => Promise<void>
  toggleFolder: (item: FileInfo) => Promise<void>; flattenTree: (items: FileInfo[], depth: number) => FileInfo[]
}

/** Zustand store managing vault lifecycle and file tree state. Persists vaultPath + expanded to localStorage. */
export const useVaultStore = create<VaultState>()(
  persist(
    (set, get) => ({
      name: '', isOpen: false, vaultPath: '',
      tree: [], visibleItems: [], expanded: {}, childrenCache: {}, loading: false,

      /** Open a directory picker and load the selected folder as vault. */
      openVault: async () => {
        try {
          const { open } = await import('@tauri-apps/plugin-dialog')
          const path = await open({ directory: true, multiple: false, title: 'Open Vault' })
          if (!path) return
          set({ loading: true })
          const res = await invoke<string>('open_vault', { path })
          const d = JSON.parse(res)
          set({ name: d.name, vaultPath: path, isOpen: true, expanded: {} })
          await get().loadTree()
          set({ loading: false })
        } catch (e) { console.error(e); toast.error('Failed to open vault'); set({ loading: false }) }
      },
      /** Close vault and reset all state. */
      closeVault: () => {
        invoke('close_vault')
        set({ name: '', isOpen: false, vaultPath: '', tree: [], visibleItems: [], expanded: {}, childrenCache: {} })
      },
      /** Reopen vault from persisted path (called on app mount after persist rehydration). */
      resumeVault: async () => {
        const { vaultPath, expanded } = get()
        if (!vaultPath) return
        set({ loading: true })
        try {
          const res = await invoke<string>('open_vault', { path: vaultPath })
          const d = JSON.parse(res)
          set({ name: d.name, isOpen: true, expanded: expanded || {} })
          await get().loadTree()
        } catch {
          // Vault can't be reopened (deleted/moved) — clear persisted state
          set({ vaultPath: '', expanded: {}, isOpen: false })
        } finally {
          set({ loading: false })
        }
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
        set({ childrenCache: cc, visibleItems: get().flattenTree(tree, 0) })
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
    }),
    {
      name: 'docubook:vault',
      partialize: (state) => ({ vaultPath: state.vaultPath, expanded: state.expanded }),
      onRehydrateStorage: () => (state) => { state?.resumeVault?.() },
    }
  )
)
