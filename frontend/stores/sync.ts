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
}

/** An edit that could not be applied because disk changed underneath it. */
export interface Conflict {
  /** Stable identity for dismissal/UI tracking. */
  id: string
  path: string
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
  addConflict: (c: Omit<Conflict, 'id' | 'detectedAt'>) => void
  /** Persist a failed write for later. Supersedes any earlier queued write for
   *  the same path — only the newest content matters, and replaying stale writes
   *  in order would just thrash the disk. */
  enqueue: (write: Omit<PendingWrite, 'seq' | 'queuedAt' | 'contentVersion'>) => void
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
  /** Resolve by saving the local copy beside the original, leaving disk intact. */
  resolveKeepBoth: (path: string) => Promise<string | null>
  /** Attempt to flush the queue; safe to call repeatedly and concurrently. */
  drain: () => Promise<void>
  /** Queue depth — drives the "N changes pending" indicator. */
  pendingCount: () => number
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

/** Suffix inserted before the extension for a "keep both" copy. Exported so the
 *  editor store can name the same companion file in its toast. */
export function conflictCopyPath(path: string, suffix = ' (conflicted copy)'): string {
  const slash = path.lastIndexOf('/')
  const dir = slash === -1 ? '' : path.slice(0, slash + 1)
  const name = path.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  return `${dir}${stem}${suffix}${ext}`
}

function uniqueConflictCopyPath(path: string): string {
  return conflictCopyPath(path, ` (conflicted copy ${createId('')})`)
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

export const useSyncStore = create<SyncState>()(
  persist(
    (set, get) => {
      let seqCounter = 0
      let backoffTimer: ReturnType<typeof setTimeout> | null = null

      const scheduleRetry = () => {
        if (backoffTimer) return
        const { attempts } = get()
        const delay = Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS)
        backoffTimer = setTimeout(() => {
          backoffTimer = null
          void get().drain()
        }, delay)
      }

      const conflictPaths = () => new Set(get().conflicts.map(c => c.path))

      /** Write one queued item; returns true when it should leave the queue. */
      const flushOne = async (item: PendingWrite): Promise<boolean> => {
        let outcome: WriteOutcome
        try {
          const raw = await invoke<string>('write_file_checked', {
            path: item.path,
            content: item.content,
            baseVersion: item.baseVersion,
          })
          outcome = JSON.parse(raw) as WriteOutcome
        } catch (error) {
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
            failures: [...get().failures.filter(f => f.path !== item.path), {
              id: createId('failure'), path: item.path, content: item.content, baseVersion: item.baseVersion,
              error: error instanceof Error ? error.message : String(error), detectedAt: Date.now(),
            }],
            lastError: String(error),
          })
          return true
        }

        if (outcome.status === 'written') {
          set({ queue: get().queue.filter(q => q.seq !== item.seq) })
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
          // rather than stacking a second dialog for the same file.
          set({ conflicts: [...get().conflicts.filter(x => x.path !== c.path), { ...c, id: createId('conflict'), detectedAt: Date.now() }] })
        },

        enqueue: (write) => {
          const item: PendingWrite = {
            ...write,
            seq: ++seqCounter,
            queuedAt: Date.now(),
            contentVersion: contentVersion(write.content),
          }
          // Drop older queued writes for this path — replaying an intermediate
          // state only risks a spurious conflict against our own history.
          const rest = get().queue.filter(q => q.path !== write.path)
          set({ queue: [...rest, item] })
        },

        discard: (path) => {
          set({ queue: get().queue.filter(q => q.path !== path), conflicts: get().conflicts.filter(c => c.path !== path), failures: get().failures.filter(f => f.path !== path) })
        },

        retryFailure: (path) => {
          const failure = get().failures.find(f => f.path === path)
          if (!failure) return
          set({ failures: get().failures.filter(f => f.path !== path) })
          get().enqueue({ path, content: failure.content, baseVersion: failure.baseVersion })
          void get().drain()
        },

        discardFailure: (path) => set({ failures: get().failures.filter(f => f.path !== path) }),

        hasConflict: (path) => conflictPaths().has(path),

        resolveKeepMine: async (path) => {
          const conflict = get().conflicts.find(c => c.path === path)
          if (!conflict) return false
          // Re-base on the current disk version so this write is allowed through:
          // the user has explicitly seen the other side and chosen to overwrite it.
          let raw: string
          try {
            raw = await invoke<string>('write_file_checked', {
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
            set({ conflicts: get().conflicts.filter(c => c.path !== path) })
            return true
          }
          // Someone changed it again mid-resolution. Keep the conflict open and
          // refresh "theirs" to the newest disk state instead of looping.
          set({
            conflicts: get().conflicts.map(c => c.path === path
              ? { ...c, id: createId('conflict'), theirs: outcome.disk, theirsVersion: outcome.version, detectedAt: Date.now() }
              : c),
          })
          return false
        },

        resolveKeepTheirs: (path) => {
          // Disk already holds the winning content — resolution is purely
          // dropping our local edit, so there is nothing to write.
          set({ conflicts: get().conflicts.filter(c => c.path !== path) })
        },

        resolveKeepBoth: async (path) => {
          const conflict = get().conflicts.find(c => c.path === path)
          if (!conflict) return null
          let copyPath = conflictCopyPath(path)
          for (let attempt = 0; attempt < 2; attempt++) {
            const raw = await invoke<string>('write_file_checked', {
              path: copyPath,
              content: conflict.mine,
              baseVersion: null,
            })
            const outcome = JSON.parse(raw) as WriteOutcome
            if (outcome.status === 'written') {
              set({ conflicts: get().conflicts.filter(c => c.path !== path) })
              return copyPath
            }
            // Only a target-exists conflict means the candidate name collided.
            // Missing/legacy reason is treated conservatively as a version conflict.
            if (outcome.reason !== 'target_exists') throw new Error('Could not create a conflicted copy because the target changed')
            copyPath = uniqueConflictCopyPath(path)
          }
          throw new Error('Could not create a conflicted copy; both candidate names are occupied')
        },

        drain: async () => {
          const state = get()
          if (state.draining) return
          if (state.queue.length === 0) {
            set({ attempts: 0, lastError: '' })
            return
          }
          // Order matters only across distinct paths; per-path supersession is
          // already handled at enqueue time.
          set({ draining: true })
          let progressed = false
          let failed = false
          try {
            for (const item of [...get().queue]) {
              // A newer edit for the same path already replaced this one.
              if (!get().queue.some(q => q.seq === item.seq)) continue
              const done = await flushOne(item)
              if (done) progressed = true
              else { failed = true; break }
            }
          } finally {
            set({ draining: false })
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
            if (get().queue.length > 0) scheduleRetry()
          }
        },

        pendingCount: () => get().queue.length,
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
