import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { IpcError, invoke } from '../lib/ipc'
import { logger } from '../utils/logger'

/**
 * Offline editing, conflict resolution, and background sync.
 *
 * WHY this exists
 * ---------------
 * The editor used to write blindly: `write_file` overwrote whatever was on disk.
 * Two failure modes followed from that:
 *
 *  1. Clobbering. An edit made before an external change (another editor, a git
 *     checkout, a second device in the web build) overwrote that change with no
 *     trace. Silent data loss.
 *  2. Losing unsaved work. When the backend was unreachable the pending write
 *     threw, the tab kept its `dirty` flag, and a reload/crash discarded it.
 *
 * The fix is a content-version guard plus a durable queue:
 *
 *  - Every open file carries a `baseVersion` — the hash of the bytes the edit was
 *    based on (see `content_version` in the Rust vault). A write ships that token
 *    and the backend REJECTS it when disk moved on. The write is never applied
 *    speculatively, so a rejected edit cannot corrupt anything.
 *  - A rejected write becomes a `Conflict` record the user resolves explicitly.
 *  - A write that fails because the backend is unreachable is enqueued. The queue
 *    persists to localStorage, survives reloads, and drains on reconnect via the
 *    `online` event / a backoff timer.
 *
 * Deliberately NOT here: merge heuristics. Auto-merging two prose edits produces
 * confident garbage; the user is the only one who can decide. We surface both
 * sides and let them choose.
 */

/** A write guarded by the disk version it was based on. */
export interface PendingWrite {
  /** Vault-relative path. */
  path: string
  /** Absolute path of the vault this write belongs to. Records written before
   *  vault scoping existed have no value here; see `isSyncRecordInScope`. */
  vaultPath?: string
  /** Full file content (frontmatter + body) to write. */
  content: string
  /** Hash of the content this edit was based on; null when the file was new. */
  baseVersion: string | null
  /** Monotonic sequence — later writes for the same path supersede earlier ones. */
  seq: number
  /** Wall-clock ms when the write was first attempted (diagnostics + ordering). */
  queuedAt: number
  /** Hash of `content`, so a queued write can be skipped once disk already matches. */
  contentVersion: string
  /** `contentVersion` of the queued write this one continues: the tab was
   *  showing that write's content when it was edited again. When that write
   *  lands (it may already be in flight), this one is rebased onto the version
   *  it produced instead of conflicting with its own predecessor. */
  parentVersion?: string
}

/** An edit that could not be applied because disk changed underneath it. */
export interface Conflict {
  /** Stable identity for dismissal/UI tracking. */
  id: string
  path: string
  /** Absolute path of the vault this conflict belongs to. */
  vaultPath?: string
  /** What the user was trying to save. */
  mine: string
  /** What is on disk now — the winning side until the user decides. */
  theirs: string
  /** Version token of `theirs`; used to re-base after the user picks a side. */
  theirsVersion: string
  /** Version the user's edit branched from — the merge base for a 3-way view. */
  baseContent: string | null
  detectedAt: number
}

export interface SyncFailure {
  id: string
  path: string
  /** Absolute path of the vault this failure belongs to. */
  vaultPath?: string
  content: string
  baseVersion: string | null
  error: string
  detectedAt: number
}

/** Result shape of the `write_file_checked` backend command. */
type WriteOutcome =
  | { status: 'written'; version: string }
  | { status: 'conflict'; disk: string; version: string; reason?: 'version_mismatch' | 'target_exists' }

const MAX_ATTEMPTS = 5
/** Backoff between drain attempts, ms. Exponential, capped. */
const BASE_BACKOFF_MS = 1500
const MAX_BACKOFF_MS = 60_000

interface SyncState {
  /** Durable queue of writes awaiting the backend. Order = insertion. */
  queue: PendingWrite[]
  /** Unresolved conflicts, keyed by path in `conflictsByPath` for O(1) lookup. */
  conflicts: Conflict[]
  /** Permanent failures retained until the user retries or discards them. */
  failures: SyncFailure[]
  /** True while a drain pass is running — guards against overlapping drains. */
  draining: boolean
  /** Consecutive failed drain attempts; drives backoff. Reset on success. */
  attempts: number
  /** Human-readable reason the last drain failed, or '' when healthy. */
  lastError: string

  /** Record a conflict detected by a direct (non-queued) write. */
  addConflict: (c: Omit<Conflict, 'id' | 'detectedAt' | 'vaultPath'>) => void
  /** Persist a failed write for later. Supersedes any earlier queued write for
   *  the same path — only the newest content matters, and replaying stale writes
   *  in order would just thrash the disk. */
  enqueue: (write: Omit<PendingWrite, 'seq' | 'queuedAt' | 'contentVersion' | 'vaultPath'>) => void
  /** The write still queued for `path` in this vault, if any. */
  queuedWrite: (path: string) => PendingWrite | undefined
  /** Drop a queued write without applying it (user discarded the change). */
  discard: (path: string) => void
  retryFailure: (path: string) => void
  discardFailure: (path: string) => void
  /** True when the path has an unresolved conflict. */
  hasConflict: (path: string) => boolean
  /** Resolve a conflict by keeping the local edit and overwriting disk. */
  resolveKeepMine: (path: string) => Promise<boolean>
  /** Resolve a conflict by adopting the disk content and dropping the local edit. */
  resolveKeepTheirs: (path: string) => void

  /** Attempt to flush the queue; safe to call repeatedly and concurrently. */
  drain: () => Promise<void>
  /** Queue depth — drives the "N changes pending" indicator. */
  pendingCount: () => number
  /** Drop every record and cancel retries. Called on logout so one account's
   *  note contents never survive into the next session. */
  reset: () => void
}

/** Stable content hash matching the Rust `content_version` (FNV-1a, 64-bit).
 *
 *  The backend is the authority — it re-hashes on every checked write — but the
 *  queue needs to answer "does disk already hold this?" without a round trip, and
 *  that answer must use the same function or it would be wrong in the common
 *  case. Kept byte-for-byte in sync with `vault::content_version`.
 *
 *  Uses BigInt because a 64-bit FNV product overflows JS numbers and would lose
 *  the low bits that carry the hash. */
export function contentVersion(content: string): string {
  const OFFSET = 0xcbf29ce484222325n
  const PRIME = 0x100000001b3n
  const MASK = 0xffffffffffffffffn
  const bytes = new TextEncoder().encode(content)
  let hash = OFFSET
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * PRIME) & MASK
  }
  return hash.toString(16).padStart(16, '0')
}


const RETRYABLE = /cannot reach server|not responding|no vault|timed out|network|failed to fetch|load failed/i

function createId(prefix = 'id'): string {
  const value = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return prefix ? `${prefix}-${value}` : value
}

/** Whether a failed write is worth retrying later (transport/backend down) as
 *  opposed to a permanent input error (bad path, permission denied) that would
 *  fail identically forever and should surface immediately instead of looping. */
export function isRetryableError(error: unknown): boolean {
  const ipc = (typeof IpcError !== 'undefined' && error instanceof IpcError)
    ? error
    : (error && typeof error === 'object' && 'status' in error ? error as { status?: number } : null)
  if (ipc) return ipc.status === 401 || ipc.status === 408 || ipc.status === 429 || (ipc.status !== undefined && ipc.status >= 500)
  return RETRYABLE.test(error instanceof Error ? error.message : String(error))
}


/** The `partialize` projection is the contract that decides what survives a
 *  reload — the durable half of "durable queue". Kept as a named function so the
 *  test can assert it without reaching into `localStorage`, which `persist`
 *  captures once at store creation. */
export function persistedSyncState(state: SyncState): { queue: PendingWrite[]; conflicts: Conflict[]; failures: SyncFailure[] } {
  return { queue: state.queue, conflicts: state.conflicts, failures: state.failures }
}

/** The vault whose records the store may touch. Set by the vault store on every
 *  open/close so queued writes, conflicts, and failures can never be applied to
 *  (or shown for) a different vault — a relative path such as `notes/a.md` means
 *  different files in different vaults. */
let activeVaultPath = ''

/** Bumped whenever the scope is reset, so an in-flight drain cannot write state
 *  that belongs to the previous session back into a cleared store. */
let generation = 0
const inFlightWrites = new Set<Promise<unknown>>()

/** Wait until writes already dispatched to the active backend have settled. */
export async function waitForSyncWrites(): Promise<void> {
  await Promise.allSettled(inFlightWrites)
}

function invokeTrackedWrite(args: Record<string, unknown>): Promise<string> {
  const write = invoke<string>('write_file_checked', args)
  inFlightWrites.add(write)
  void write.then(() => inFlightWrites.delete(write), () => inFlightWrites.delete(write))
  return write
}

export function setSyncVaultScope(vaultPath: string): void {
  if (vaultPath === activeVaultPath) return
  activeVaultPath = vaultPath
  // A drain in flight against the old vault must not publish its results here.
  generation++
}

/** Whether a persisted record belongs to the given vault.
 *
 *  Records created before vault scoping have no `vaultPath`. They are treated as
 *  in scope rather than discarded: an offline edit is unrecoverable work, so the
 *  upgrade path keeps it available in whichever vault is opened next. New
 *  records are always stamped, so cross-vault leakage is impossible going
 *  forward (and logout clears the legacy ones anyway). */
export function isSyncRecordInScope(record: { vaultPath?: string }, vaultPath = activeVaultPath): boolean {
  return record.vaultPath === undefined || record.vaultPath === vaultPath
}

export const useSyncStore = create<SyncState>()(
  persist(
    (set, get) => {
      let seqCounter = 0
      let backoffTimer: ReturnType<typeof setTimeout> | null = null

      const scheduleRetry = () => {
        if (backoffTimer) return
        // Nothing for THIS vault to flush — a retry would just spin on records
        // that belong to a vault that is no longer open.
        if (!get().queue.some(q => isSyncRecordInScope(q))) return
        const { attempts } = get()
        const delay = Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS)
        backoffTimer = setTimeout(() => {
          backoffTimer = null
          void get().drain()
        }, delay)
      }

      const conflictPaths = () => new Set(get().conflicts.filter(c => isSyncRecordInScope(c)).map(c => c.path))

      /** Write one queued item; returns true when it should leave the queue. */
      const flushOne = async (item: PendingWrite, gen: number): Promise<boolean> => {
        /** True once the record no longer belongs to the session that started
         *  the drain: either the vault changed or the store was reset. Results
         *  are dropped instead of published into the new scope. */
        const abandoned = () => gen !== generation || !isSyncRecordInScope(item)
        let outcome: WriteOutcome
        try {
          const raw = await invokeTrackedWrite({
            path: item.path,
            content: item.content,
            baseVersion: item.baseVersion,
          })
          outcome = JSON.parse(raw) as WriteOutcome
        } catch (error) {
          if (abandoned()) return true
          if (isRetryableError(error)) {
            logger.warn('write_deferred', { path: item.path, error })
            return false
          }
          // A permanent backend error is not a version conflict. Retain the
          // exact content as an actionable failure instead of routing it through
          // conflict resolution with a fabricated disk version.
          logger.error('queued_write_failed', { error, path: item.path })
          set({
            queue: get().queue.filter(q => q.seq !== item.seq),
            failures: [...get().failures.filter(f => !(f.path === item.path && isSyncRecordInScope(f))), {
              id: createId('failure'), path: item.path, vaultPath: item.vaultPath,
              content: item.content, baseVersion: item.baseVersion,
              error: error instanceof Error ? error.message : String(error), detectedAt: Date.now(),
            }],
            lastError: String(error),
          })
          return true
        }

        if (abandoned()) return true

        if (outcome.status === 'written') {
          // A later edit of the same tab, queued while this write was pending,
          // was based on this content: it now continues from the version just
          // written instead of the one this write replaced.
          set({
            queue: get().queue
              .filter(q => q.seq !== item.seq)
              .map(q => q.path === item.path && q.parentVersion === item.contentVersion && isSyncRecordInScope(q)
                ? { ...q, baseVersion: outcome.version, parentVersion: undefined }
                : q),
          })
          // Dynamic on purpose: editor.ts imports this module statically
          // (useSyncStore/contentVersion/isRetryableError), so a static import
          // back would form an ESM cycle. The cycle is harmless at call time
          // (this only runs after a write completes, long past eval), and
          // rolldown's INEFFECTIVE_DYNAMIC_IMPORT warning is expected here —
          // editor.ts is in the main chunk anyway, so there is nothing to split.
          const { useEditorStore } = await import('./editor')
          useEditorStore.getState().rebaseQueuedWrite(item.path, item)
          return true
        }

        // Disk moved on while we were offline — the edit is preserved for the
        // user to resolve instead of overwriting whoever got there first.
        set({ queue: get().queue.filter(q => q.seq !== item.seq) })
        get().addConflict({
          path: item.path,
          mine: item.content,
          theirs: outcome.disk,
          theirsVersion: outcome.version,
          baseContent: null,
        })
        return true
      }

      return {
        queue: [],
        conflicts: [],
        draining: false,
        attempts: 0,
        lastError: '',
        failures: [],

        addConflict: (c) => {
          // One conflict per path: a later detection supersedes an earlier one
          // rather than stacking a second dialog for the same file. Supersession
          // is scoped too — the same relative path in another vault is a
          // different file and must keep its own record.
          set({ conflicts: [...get().conflicts.filter(x => !(x.path === c.path && isSyncRecordInScope(x))), {
            ...c, vaultPath: activeVaultPath, id: createId('conflict'), detectedAt: Date.now(),
          }] })
        },

        enqueue: (write) => {
          const item: PendingWrite = {
            ...write,
            vaultPath: activeVaultPath,
            seq: ++seqCounter,
            queuedAt: Date.now(),
            contentVersion: contentVersion(write.content),
          }
          // Drop older queued writes for this path — replaying an intermediate
          // state only risks a spurious conflict against our own history.
          const rest = get().queue.filter(q => !(q.path === write.path && isSyncRecordInScope(q)))
          set({ queue: [...rest, item] })
          // Nothing else drains a queue filled while the browser stayed online
          // (a restarting server, a backend error): retry on the backoff timer.
          scheduleRetry()
        },

        queuedWrite: (path) => get().queue.find(q => q.path === path && isSyncRecordInScope(q)),

        discard: (path) => {
          set({
            queue: get().queue.filter(q => !(q.path === path && isSyncRecordInScope(q))),
            conflicts: get().conflicts.filter(c => !(c.path === path && isSyncRecordInScope(c))),
            failures: get().failures.filter(f => !(f.path === path && isSyncRecordInScope(f))),
          })
        },

        retryFailure: (path) => {
          const failure = get().failures.find(f => f.path === path && isSyncRecordInScope(f))
          if (!failure) return
          set({ failures: get().failures.filter(f => f.id !== failure.id) })
          get().enqueue({ path, content: failure.content, baseVersion: failure.baseVersion })
          void get().drain()
        },

        discardFailure: (path) => set({
          failures: get().failures.filter(f => !(f.path === path && isSyncRecordInScope(f))),
        }),

        hasConflict: (path) => conflictPaths().has(path),

        resolveKeepMine: async (path) => {
          const conflict = get().conflicts.find(c => c.path === path && isSyncRecordInScope(c))
          if (!conflict) return false
          // Re-base on the current disk version so this write is allowed through:
          // the user has explicitly seen the other side and chosen to overwrite it.
          let raw: string
          try {
            raw = await invokeTrackedWrite({
              path,
              content: conflict.mine,
              baseVersion: conflict.theirsVersion,
            })
          } catch (error) {
            if (isRetryableError(error)) {
              logger.warn('conflict_resolution_deferred', { path, error })
              return false
            }
            throw error
          }
          const outcome = JSON.parse(raw) as WriteOutcome
          if (outcome.status === 'written') {
            set({ conflicts: get().conflicts.filter(c => c.id !== conflict.id) })
            return true
          }
          // Someone changed it again mid-resolution. Keep the conflict open and
          // refresh "theirs" to the newest disk state instead of looping.
          set({
            conflicts: get().conflicts.map(c => c.id === conflict.id
              ? { ...c, id: createId('conflict'), theirs: outcome.disk, theirsVersion: outcome.version, detectedAt: Date.now() }
              : c),
          })
          return false
        },

        resolveKeepTheirs: (path) => {
          // Disk already holds the winning content — resolution is purely
          // dropping our local edit, so there is nothing to write.
          const conflict = get().conflicts.find(c => c.path === path && isSyncRecordInScope(c))
          if (!conflict) return
          set({ conflicts: get().conflicts.filter(c => c.id !== conflict.id) })
        },


        drain: async () => {
          const state = get()
          if (state.draining) return
          const gen = generation
          // Only this vault's records may touch disk: the backend's path space
          // is the vault that is currently open.
          const pending = state.queue.filter(q => isSyncRecordInScope(q))
          if (pending.length === 0) {
            set({ attempts: 0, lastError: '' })
            return
          }
          // Order matters only across distinct paths; per-path supersession is
          // already handled at enqueue time.
          set({ draining: true })
          let progressed = false
          let failed = false
          try {
            for (const item of pending) {
              // The vault changed or the store was reset while this pass ran.
              if (gen !== generation) break
              // A newer edit for the same path already replaced this one.
              if (!get().queue.some(q => q.seq === item.seq)) continue
              const done = await flushOne(item, gen)
              if (done) progressed = true
              else { failed = true; break }
            }
          } finally {
            set({ draining: false })
          }
          if (gen !== generation) {
            // The vault changed (or the store was reset) mid-pass. If the new
            // scope has work, it still needs a pass — the caller's own drain may
            // have been skipped because `draining` was set.
            scheduleRetry()
            return
          }
          if (failed) {
            const attempts = get().attempts + 1
            set({ attempts, lastError: 'Waiting for the backend' })
            if (attempts >= MAX_ATTEMPTS) {
              logger.error('sync_drain_exhausted', { attempts, pending: get().queue.length })
            }
            scheduleRetry()
          } else if (progressed) {
            set({ attempts: 0, lastError: '' })
          }
          // Anything left for this vault still needs a pass — either a write was
          // superseded mid-drain or new work arrived while it ran.
          if (!failed && get().queue.some(q => isSyncRecordInScope(q))) scheduleRetry()
        },

        pendingCount: () => get().queue.filter(q => isSyncRecordInScope(q)).length,

        reset: () => {
          generation++
          if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null }
          set({ queue: [], conflicts: [], failures: [], draining: false, attempts: 0, lastError: '' })
        },
      }
    },
    {
      name: 'docubook:sync',
      // `draining` is runtime-only: persisting it would wedge the queue in a
      // permanently-"busy" state after a crash mid-drain, so the projection
      // deliberately narrows to the two durable collections.
      partialize: persistedSyncState,

    },
  ),
)

/** Drain the queue when connectivity returns. Wired once from `App`.
 *  The `online` event does not fire when the server is up but the vault is
 *  closed, so a successful vault open also drains — see `vaultStore.openVault`. */
export function installSyncListeners(canDrain: () => boolean = () => true): () => void {
  const drain = () => { if (canDrain()) void useSyncStore.getState().drain() }
  window.addEventListener('online', drain)
  drain()
  return () => window.removeEventListener('online', drain)
}
