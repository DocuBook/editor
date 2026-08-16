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

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in (window as any)

type Listener = (e: { payload: any }) => void
const bus = new Map<string, Set<Listener>>()

/** Same signature as @tauri-apps/api/event.listen. */
export async function listen<T>(event: string, cb: (e: { payload: T }) => void): Promise<UnlistenFn> {
  if (isTauri) {
    const { listen } = await import('@tauri-apps/api/event')
    return listen<T>(event, cb)
  }
  const fn = cb as unknown as Listener
  if (!bus.has(event)) bus.set(event, new Set())
  bus.get(event)!.add(fn)
  return () => { bus.get(event)?.delete(fn) }
}

/** Dispatch to local bus (web mode only; tauri events are emitted server-side). */
function emit(event: string, payload: unknown) {
  bus.get(event)?.forEach(fn => fn({ payload }))
}

/** Same signature as @tauri-apps/api/core.invoke. */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<T>(cmd, args as any)
  }
  if (cmd === 'ask_ai') {
    await streamAskAi(args ?? {})
    return undefined as T
  }
  const data = await post(cmd, args ?? {})
  return data as T
}

async function post(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(`/api/${cmd}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (e) {
    throw new Error(e instanceof DOMException && e.name === 'TimeoutError' ? 'Server is not responding' : 'Cannot reach server')
  }
  const data = await res.json().catch(() => ({}))
  if (res.status === 401) {
    emit('auth:unauthorized', undefined)
    throw new Error((data as any).error || 'Unauthorized')
  }
  if (!res.ok || (data as any).error) throw new Error((data as any).error || `HTTP ${res.status}`)
  return (data as any).result
}

/** ask_ai streams SSE events from the server → re-emit on the local bus,
 *  resolve when the stream completes (mirrors the tauri emit flow). */
async function streamAskAi(args: Record<string, unknown>) {
  const res = await fetch('/api/ask_ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(args),
  })
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}))
    throw new Error((data as any).error || `HTTP ${res.status}`)
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
    watchdog = setTimeout(() => { stalled = true; void reader.cancel().catch(() => {}) }, 60_000)
  }
  arm()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line.startsWith('event:')) continue
        const ev = line.slice(6).trim()
        const nl = buf.indexOf('\n')
        const dataLine = nl >= 0 ? buf.slice(0, nl).trim() : buf.trim()
        if (nl >= 0) buf = buf.slice(nl + 1)
        if (!dataLine.startsWith('data:')) continue
        const payload = dataLine.slice(5).trim()
        arm()
        if (ev === 'ai:token') {
          try { emit('ai:token', JSON.parse(payload)) } catch { /* ignore malformed */ }
        } else if (ev === 'ai:tool_call') {
          try { emit('ai:tool_call', JSON.parse(payload)) } catch { /* ignore */ }
        } else if (ev === 'ai:tools_done') {
          emit('ai:tools_done', '')
        } else if (ev === 'ai:done') {
          try { emit('ai:done', JSON.parse(payload)) } catch { emit('ai:done', {}) }
        } else if (ev === 'error') {
          throw new Error(payload || 'AI request failed')
        }
      }
    }
  } finally {
    if (watchdog) clearTimeout(watchdog)
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
  const { pickServerVault } = await import('../components/VaultPicker')
  return pickServerVault()
}

/**
 * Resolve an absolute vault file path to a loadable URL:
 * - Tauri: `convertFileSrc` (asset protocol) — binary files can't go through IPC.
 * - Web:   relative vault path (server serves vault files under the vault root).
 */
export async function fileUrl(vaultPath: string, relPath: string): Promise<string> {
  if (isTauri) {
    try {
      const { convertFileSrc } = await import('@tauri-apps/api/core')
      return convertFileSrc(`${vaultPath}/${relPath}`)
    } catch { /* fall through to relative */ }
  }
  return relPath
}
