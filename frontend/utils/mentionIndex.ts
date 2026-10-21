import { invoke } from '../lib/ipc'

/** A vault entry offered by the mention picker. */
export type MentionEntry = { path: string; name: string; type: string }

export interface MentionIndex {
  entries: MentionEntry[]
  unreadable: number
}

/** Concurrent `list_tree` calls. Serial recursion made the dropdown wait for the
 *  whole vault; unbounded fan-out would flood the IPC. */
const MENTION_LIST_CONCURRENCY = 6

/** How long a walk is reused across picker openings. The tree changes rarely
 *  relative to how often `@` is typed, and `invalidateMentionIndex` (called on
 *  every tree reload) keeps the common case exact — the TTL only bounds staleness
 *  when something changes the vault without a tree refresh (e.g. an external
 *  editor or a git checkout). */
const INDEX_TTL_MS = 30_000

type Cache = { vault: string; at: number; index: MentionIndex }

let cache: Cache | null = null
let inFlight: { vault: string; promise: Promise<MentionIndex> } | null = null
/** Bumped by `invalidateMentionIndex`. A walk that started before the bump must
 *  not publish its result — the tree it described is already out of date. */
let generation = 0

/** Recursive vault listing for the mention picker.
 *
 *  A folder that cannot be listed (deleted/renamed mid-walk, permissions) only
 *  skips its own subtree — rejecting the whole walk would blank the dropdown,
 *  which is what made files "disappear" from the suggestions. Returns the count
 *  so the UI can say so instead of pretending the vault is empty. */
async function walkVault(): Promise<MentionIndex> {
  const entries: MentionEntry[] = []
  let unreadable = 0
  let queue = ['']
  while (queue.length > 0) {
    const batch = queue.splice(0, MENTION_LIST_CONCURRENCY)
    const results = await Promise.all(batch.map(async (subpath): Promise<{ subpath: string; children: MentionEntry[] } | null> => {
      try {
        const value = await invoke<string>('list_tree', { subpath })
        const children = (typeof value === 'string' ? JSON.parse(value) : value) as MentionEntry[]
        return { subpath, children: Array.isArray(children) ? children : [] }
      } catch {
        unreadable += 1
        return null
      }
    }))
    const next: string[] = []
    for (const result of results) {
      if (!result) continue
      for (const child of result.children) {
        const path = result.subpath ? `${result.subpath}/${child.name}` : child.name
        // Folders stay selectable: a folder mention reads it recursively.
        if (child.type === '1') { entries.push({ ...child, path }); next.push(path) }
        else if (/\.(md|mdx)$/i.test(child.name)) entries.push({ ...child, path })
      }
    }
    queue = queue.concat(next)
  }
  /** Folders first (as in the file tree), then files, each alphabetical. */
  entries.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === '1' ? -1 : 1))
  return { entries, unreadable }
}

/** Load the mention index for a vault, reusing a recent walk when possible.
 *
 *  One walk per vault, not one per picker opening: each walk issues one
 *  `list_tree` per folder, so on a large vault reopening `@` used to redo all of
 *  it. Concurrent callers share the same in-flight walk. */
export function loadMentionIndex(vaultPath: string): Promise<MentionIndex> {
  const vault = vaultPath ?? ''
  if (cache && cache.vault === vault && Date.now() - cache.at < INDEX_TTL_MS) {
    return Promise.resolve(cache.index)
  }
  if (inFlight?.vault === vault) return inFlight.promise

  const gen = generation
  const promise = walkVault().then((index) => {
    if (gen === generation) cache = { vault, at: Date.now(), index }
    if (inFlight?.promise === promise) inFlight = null
    return index
  }, (error) => {
    if (inFlight?.promise === promise) inFlight = null
    throw error
  })
  inFlight = { vault, promise }
  return promise
}

/** Drop the cached walk. Called whenever the vault tree reloads (create,
 *  rename, delete, external refresh) so the next picker opening sees it. */
export function invalidateMentionIndex(): void {
  generation++
  cache = null
  inFlight = null
}
