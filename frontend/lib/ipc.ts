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

const REQUEST_TIMEOUT_MS = 30_000
const SSE_IDLE_TIMEOUT_MS = 60_000

type Listener = (e: { payload: unknown }) => void
const bus = new Map<string, Set<Listener>>()

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
  if (isTauri) {
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
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<T>(cmd, args)
  }
  if (cmd === 'ask_ai') {
    const controller = new AbortController()
    activeAskAiController = controller
    try {
      await streamAskAi(args ?? {}, controller.signal)
    } finally {
      if (activeAskAiController === controller) activeAskAiController = null
    }
    return undefined as T
  }
  if (cmd === 'cancel_ai') activeAskAiController?.abort()
  const data = await post(cmd, args ?? {})
  return data as T
}

let activeAskAiController: AbortController | null = null

async function post(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(`/api/${cmd}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(args),
      signal: controller.signal,
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
      throw new Error(message || 'Unauthorized')
    }
    if (!res.ok || message) throw new Error(message || `HTTP ${res.status}`)
    return body.result
  } finally {
    clearTimeout(timeout)
  }
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
    if (event !== 'ai:token' && event !== 'ai:tool_call' && event !== 'ai:tools_done' && event !== 'ai:done') return
    emit(event, parseSseJson(payload))
  }
  const takeFrame = () => {
    const match = buf.match(/\r\n\r\n|\n\n|\r\r/)
    if (!match || match.index === undefined) return null
    const frame = buf.slice(0, match.index)
    buf = buf.slice(match.index + match[0].length)
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

/**
 * Resolve a vault-relative path to a loadable URL:
 * - Tauri: reads the file via IPC (path-traversal protected) and returns a
 *   base64 data: URL — no asset protocol, no whole-filesystem webview access.
 * - Web:   `/api/file?path=…` (server endpoint, behind the same auth gate).
 */
export async function fileUrl(vaultPath: string, relPath: string): Promise<string> {
  const abs = `${vaultPath}/${relPath}`
  if (isTauri) {
    const b64 = await invoke<string>('read_file_binary', { path: relPath })
    return `data:${mimeFromPath(relPath)};base64,${b64}`
  }
  return `/api/file?path=${encodeURIComponent(abs)}`
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
