/**
 * IPC bridge — one abstraction over two runtimes:
 *
 * - Tauri desktop: delegates to @tauri-apps/api (invoke / event / plugin-dialog).
 * - Web (Docker self-host): POST /api/<cmd>, SSE for ask_ai streaming, a local
 *   event bus mirroring Tauri's event names so UI code is unchanged.
 *
 * The UI imports `invoke`/`listen`/`openDir` from here instead of the tauri
 * packages directly; the rest of the app is runtime-agnostic.
 */
import type { UnlistenFn } from '@tauri-apps/api/event'

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
export const isMacTauri = isTauri && import.meta.env.TAURI_ENV_PLATFORM === 'darwin'

const REQUEST_TIMEOUT_MS = 30_000
const SSE_IDLE_TIMEOUT_MS = 60_000

export class IpcError extends Error {
  readonly status?: number
  readonly code?: string

  constructor(message: string, status?: number, code?: string) {
    super(message)
    this.name = 'IpcError'
    this.status = status
    this.code = code
  }
}

type Listener = (e: { payload: unknown }) => void
const bus = new Map<string, Set<Listener>>()

/** Events of an `ask_ai` stream. Both runtimes deliver them on the local bus:
 *  web re-emits its SSE frames, desktop its per-request channel. They are never
 *  global Tauri events, so a listener costs no IPC round trip and a stream only
 *  reaches the window that asked for it. */
const AI_STREAM_EVENTS = new Set(['ai:token', 'ai:generating', 'ai:tool_call', 'ai:tools_done', 'ai:done'])
/** Last message of a desktop `ask_ai` channel (`AI_END_EVENT` in agent.rs). */
const AI_END_EVENT = 'ai:end'
/** How long a finished desktop `ask_ai` waits for its channel to drain. Channel
 *  messages are ordered, but not against the command reply: a large tool call
 *  travels by a separate fetch and can land after it. */
const AI_CHANNEL_DRAIN_MS = 10_000

function emit(event: string, payload: unknown) {
  bus.get(event)?.forEach(fn => fn({ payload }))
}

/** Event payloads (except `error`) are JSON by contract. A payload that fails
 *  to parse means the stream was cut mid-frame — surface a protocol error
 *  instead of shipping corrupt text into the editor. */
function parseSseJson(value: string): unknown {
  try { return JSON.parse(value) } catch {
    throw new Error('AI response stream was interrupted — retry')
  }
}

/** Same signature as @tauri-apps/api/event.listen for the fields used by the UI. */
export async function listen<T>(event: string, cb: (e: { payload: T }) => void): Promise<UnlistenFn> {
  if (isTauri && !AI_STREAM_EVENTS.has(event)) {
    const { listen } = await import('@tauri-apps/api/event')
    return listen<T>(event, cb)
  }
  const fn = cb as unknown as Listener
  if (!bus.has(event)) bus.set(event, new Set())
  bus.get(event)!.add(fn)
  return () => {
    const listeners = bus.get(event)
    listeners?.delete(fn)
    if (listeners?.size === 0) bus.delete(event)
  }
}

/** Same signature as @tauri-apps/api/core.invoke. */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core')
    if (cmd === 'context_tools') {
      if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
      const requestId = String(args?.requestId ?? `context-discovery-${++anonymousContextRequest}`)
      const onAbort = () => { void invoke('cancel_context_request', { requestId }) }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        if (signal?.aborted) {
          onAbort()
          throw new DOMException('The operation was aborted', 'AbortError')
        }
        return await invoke<T>(cmd, { ...args, requestId })
      }
      finally { signal?.removeEventListener('abort', onAbort) }
    }
    if (cmd === 'ask_ai') {
      await askAiOverChannel(args ?? {})
      return undefined as T
    }
    return invoke<T>(cmd, args)
  }
  if (cmd === 'ask_ai') {
    const requestId = String((args as { requestId?: unknown })?.requestId ?? '')
    const key = askAiKey(requestId)
    const controller = new AbortController()
    let controllers = activeAskAi.get(key)
    if (!controllers) {
      controllers = new Set<AbortController>()
      activeAskAi.set(key, controllers)
    }
    controllers.add(controller)
    try {
      await streamAskAi(args ?? {}, controller.signal)
    } finally {
      // Drop only this turn's slot: a turn that finishes must not clear the slot
      // of a concurrent turn that reused the same id.
      controllers.delete(controller)
      if (controllers.size === 0 && activeAskAi.get(key) === controllers) activeAskAi.delete(key)
    }
    return undefined as T
  }
  // Cancel by request id: the AI menu can abandon a turn and immediately start a
  // new one, and a commit-message turn can run alongside it — so a late Stop must
  // target exactly one stream, and no id cancels every in-flight stream.
  if (cmd === 'cancel_ai') {
    const requestId = String((args as { requestId?: unknown })?.requestId ?? '')
    if (!requestId) {
      for (const controllers of activeAskAi.values()) {
        for (const controller of controllers) controller.abort()
      }
      activeAskAi.clear()
    } else {
      for (const controller of activeAskAi.get(requestId) ?? []) controller.abort()
      activeAskAi.delete(requestId)
    }
  }
  if (cmd === 'context_tools') {
    const requestId = String(args?.requestId ?? `context-discovery-${++anonymousContextRequest}`)
    const onAbort = () => { void post('cancel_context_request', { requestId }).catch(() => {}) }
    signal?.addEventListener('abort', onAbort, { once: true })
    try { return await post(cmd, { ...args, requestId }, signal) as T }
    finally { signal?.removeEventListener('abort', onAbort) }
  }
  const data = await post(cmd, args ?? {}, signal)
  return data as T
}

/** Cancel exactly one Rust AI stream; an empty ID means cancel every stream. */
export function cancelAiRequest(requestId: string | null | undefined): void {
  if (!requestId) return
  void invoke('cancel_ai', { requestId }).catch(() => {})
}

/** Close the desktop window through the normal close request, so the graceful
 *  shutdown path (flush + save, then `app_ready_to_close`) runs exactly as it
 *  does from the window button. No-op in the web runtime, where the window is
 *  the browser tab. */
export async function closeWindow(): Promise<void> {
  if (!isTauri) return
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  await getCurrentWindow().close()
}

let anonymousContextRequest = 0

/** In-flight ask_ai streams, grouped by request id. Concurrent turns (an AI
 *  panel edit next to a commit-message summary) must each own their cancellation
 *  handle: a late Stop targets one id, and a turn that finishes must not clear
 *  another turn's slot. Duplicate ids are retained as a group rather than
 *  overwriting a live controller; cancelling that id aborts every matching turn.
 *  Id-less callers get an isolated slot too, so they cannot clobber each other;
 *  `cancel_ai` with no id aborts all of them. */
const activeAskAi = new Map<string, Set<AbortController>>()
let anonymousAskAi = 0
function askAiKey(requestId: string): string {
  return requestId || `anon-${++anonymousAskAi}`
}

/** Commands whose request must outlive the page: a note saved while the tab is
 *  closing or hidden (see `installUnloadSave`). */
const KEEPALIVE_COMMANDS = new Set(['write_file_checked'])
/** Browsers cap the bodies of all in-flight keepalive requests at 64 KiB (in
 *  bytes, together) and reject a request over the cap outright. A larger note
 *  goes out as a normal request, which is not guaranteed to finish once the
 *  page is gone. */
const KEEPALIVE_MAX_BODY = 60_000

async function post(cmd: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const payload = JSON.stringify(args)
  const keepalive = KEEPALIVE_COMMANDS.has(cmd) && new TextEncoder().encode(payload).length <= KEEPALIVE_MAX_BODY
  let res: Response
  try {
    res = await fetch(`/api/${cmd}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: payload,
      keepalive,
      signal: signal ?? controller.signal,
    })
  } catch {
    throw new Error(controller.signal.aborted ? 'Server is not responding' : 'Cannot reach server')
  }
  try {
    let data: unknown = {}
    try { data = await res.json() }
    catch { if (controller.signal.aborted) throw new Error('Server is not responding') }
    const body = data as { error?: unknown; result?: unknown }
    const message = typeof body.error === 'string' ? body.error : undefined
    if (res.status === 401) {
      emit('auth:unauthorized', undefined)
      throw new IpcError(message || 'Unauthorized', res.status, 'UNAUTHORIZED')
    }
    if (!res.ok || message) throw new IpcError(message || `HTTP ${res.status}`, res.status)
    return body.result
  } finally {
    clearTimeout(timeout)
  }
}

/** Desktop ask_ai: events arrive on a channel owned by this request and are
 *  re-emitted on the local bus, exactly like the web SSE frames. Resolves once
 *  the command finished AND its channel delivered the end marker, so callers
 *  that read the turn after `invoke` resolves never miss its last events. */
async function askAiOverChannel(args: Record<string, unknown>) {
  const { Channel, invoke } = await import('@tauri-apps/api/core')
  let drained!: () => void
  const end = new Promise<void>(resolve => { drained = resolve })
  const channel = new Channel<{ event?: string; payload?: unknown }>(message => {
    if (message?.event === AI_END_EVENT) drained()
    else if (message?.event && AI_STREAM_EVENTS.has(message.event)) emit(message.event, message.payload)
  })
  await invoke('ask_ai', { ...args, onEvent: channel })
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<void>(resolve => { timer = setTimeout(resolve, AI_CHANNEL_DRAIN_MS) })
  await Promise.race([end, late])
  clearTimeout(timer)
}

/** ask_ai streams SSE events from the server → re-emit on the local bus,
 *  resolve when the stream completes (mirrors the tauri emit flow). */
async function streamAskAi(args: Record<string, unknown>, signal: AbortSignal) {
  const res = await fetch('/api/ask_ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    credentials: 'same-origin',
    body: JSON.stringify(args),
    signal,
  })
  if (res.status === 401) emit('auth:unauthorized', undefined)
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}))
    const message = (data as { error?: unknown }).error
    throw new Error(typeof message === 'string' ? message : `HTTP ${res.status}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  // Watchdog (P0): if the stream produces no event for 60s (stalled provider
  // mid-generation), abort and surface an error instead of hanging silently.
  let stalled = false
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    if (watchdog) clearTimeout(watchdog)
    watchdog = setTimeout(() => {
      stalled = true
      void reader.cancel().catch(() => {})
    }, SSE_IDLE_TIMEOUT_MS)
  }
  const dispatch = (frame: string) => {
    let event = ''
    const data: string[] = []
    for (const line of frame.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (!event || data.length === 0) {
      if (frame.trim()) arm()
      return
    }
    const payload = data.join('\n')
    arm()
    if (event === 'error') throw new Error(payload || 'AI request failed')
    if (!AI_STREAM_EVENTS.has(event)) return
    emit(event, parseSseJson(payload))
  }
  /** Where the next frame-terminator search starts. A large frame (a tool call
   *  carrying a whole document edit) arrives over many chunks; rescanning it
   *  from the start on every chunk was quadratic in its size. Backing up by 3
   *  keeps a terminator split across two chunks findable. */
  let scanFrom = 0
  const FRAME_END = /\r\n\r\n|\n\n|\r\r/g
  const takeFrame = () => {
    FRAME_END.lastIndex = Math.max(0, scanFrom - 3)
    const match = FRAME_END.exec(buf)
    if (!match) {
      scanFrom = buf.length
      return null
    }
    const frame = buf.slice(0, match.index)
    buf = buf.slice(match.index + match[0].length)
    scanFrom = 0
    return frame
  }
  arm()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        buf += decoder.decode()
        break
      }
      buf += decoder.decode(value, { stream: true })
      if (value.byteLength > 0) arm()
      let frame: string | null
      while ((frame = takeFrame()) !== null) dispatch(frame)
      if (stalled) break
    }
    // The server closes every frame with a blank line — leftover text means the
    // connection died mid-frame; emitting it would ship partial content.
    if (!stalled && buf.trim()) console.warn('[ipc] dropping incomplete SSE frame:', buf.slice(0, 120))
  } finally {
    if (watchdog) clearTimeout(watchdog)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  if (stalled) throw new Error('AI provider is slow — try again')
}

/**
 * Folder picker.
 * - Desktop: native directory dialog (full filesystem access).
 * - Web: the server owns the filesystem. "Open Vault" shows the vault picker
 *   modal (list / open / create); Create/Clone flows get the server vaults
 *   folder directly as parent — their own name/clone form follows, so there is
 *   no double entry and no nested-vault bug.
 */
export async function openDir(opts?: { title?: string; defaultPath?: string }): Promise<string | null> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    return open({ directory: true, multiple: false, ...opts }) as Promise<string | null>
  }
  if (opts?.title !== 'Open Vault') {
    return (await post('web_vault_root', {}) as string).trim() || null
  }
  const { pickServerVault } = await import('../utils/serverVaultPicker')
  return pickServerVault()
}

export function isAbsoluteUrl(url: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)
}

export function isSafeImageUrl(url: string): boolean {
  return !isAbsoluteUrl(url) || /^(?:https:|data:|blob:|\/\/)/i.test(url)
}

/**
 * Resolve a vault-relative path to a loadable URL:
 * - Tauri: reads the file via IPC (path-traversal protected) and returns a
 *   base64 data: URL — no asset protocol, no whole-filesystem webview access.
 * - Web:   `/api/file?path=…` (server endpoint, behind the same auth gate).
 *
 *  The path stays vault-relative on the wire: the URL must not disclose the
 *  server's filesystem layout, and the server resolves it against the active
 *  vault anyway.
 */
export async function fileUrl(relPath: string): Promise<string> {
  if (isTauri) {
    const b64 = await invoke<string>('read_file_binary', { path: relPath })
    return `data:${mimeFromPath(relPath)};base64,${b64}`
  }
  return webFileUrl(relPath)
}

/** The web counterpart of `read_file_binary`: a same-origin URL the browser
 *  fetches itself, behind the shared auth gate. */
function webFileUrl(relPath: string): string {
  return `/api/file?path=${encodeURIComponent(relPath)}`
}

/** Mirrors `vault::MAX_FILE_BYTES` on the server (16 MiB). Kept as a literal so
 *  the message reads naturally; the server remains the actual enforcer. */
const MEDIA_TOO_LARGE = 'File too large to preview (16 MB limit)'

/** Map a failed media read to a human reason.
 *  Desktop: `read_file_binary` rejects with the backend's message (the size cap
 *  included), so translate that. Web has no error here — fileUrl only builds a
 *  URL — and is handled by `mediaFailureReason` when the <img> fails. */
export function mediaErrorMessage(error: unknown): string {
  return /too large/i.test(String(error)) ? MEDIA_TOO_LARGE : 'Could not load preview'
}

/** Reason a media preview failed on web, where the browser reports a bare
 *  <img> error with no status. One HEAD request, issued only from the failure
 *  path, distinguishes missing / outside-vault / oversized instead of leaving a
 *  generic placeholder that hides which one it was. */
export async function mediaFailureReason(relPath: string): Promise<string> {
  if (isTauri) return 'Could not load preview'
  try {
    const res = await fetch(webFileUrl(relPath), {
      method: 'HEAD',
      credentials: 'same-origin',
    })
    if (res.ok) return 'Could not load preview'
    if (res.status === 413) return MEDIA_TOO_LARGE
    if (res.status === 403) return 'File is outside the active vault'
    if (res.status === 404) return 'File not found'
    if (res.status === 401) return 'Session expired — sign in again'
    return `Could not load preview (HTTP ${res.status})`
  } catch {
    return 'Cannot reach server'
  }
}

/** macOS privacy panes the app can deep-link to. Kept in one place so both the
 *  Rust command and the UI reason about the same set. */
export type SystemSettingsPane = 'accessibility' | 'automation' | 'files'

/** Sentinel the Rust side prepends to permission failures (`TRASH_PERMISSION_PREFIX`).
 *  A prefix rather than a parsed message keeps the two sides loosely coupled. */
const TRASH_PERMISSION_PREFIX = 'TRASH_PERMISSION:'

/** Detect a macOS privacy-permission failure and extract the pane to grant.
 *  Returns null for ordinary command errors, which callers surface as-is. */
export function trashPermissionError(error: unknown): { pane: SystemSettingsPane; message: string } | null {
  const raw = String(error)
  const at = raw.indexOf(TRASH_PERMISSION_PREFIX)
  if (at === -1) return null
  const pane = raw.slice(at + TRASH_PERMISSION_PREFIX.length).trim().split(/\s/)[0]
  const known: SystemSettingsPane[] = ['accessibility', 'automation', 'files']
  return {
    pane: known.find(k => k === pane) ?? 'automation',
    message: humanizePane(pane),
  }
}

function humanizePane(pane: string): string {
  if (pane === 'accessibility') return 'Put Back needs Accessibility access to move items out of the Trash.'
  if (pane === 'files') return 'Trash access needs Full Disk Access.'
  return 'Trash access needs permission to control Finder.'
}

/** Open the specific macOS System Settings pane a failed action needs. Falls
 *  back to a no-op elsewhere — callers keep the written instructions visible. */
export async function openSystemSettings(pane: SystemSettingsPane): Promise<boolean> {
  if (!isTauri) return false
  try {
    await invoke('open_system_settings', { pane })
    return true
  } catch (e) {
    console.error(e)
    return false
  }
}

/** Minimal MIME map for previewed binary files (images etc). */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
}
function mimeFromPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
  return MIME_BY_EXT[ext] || 'application/octet-stream'
}
