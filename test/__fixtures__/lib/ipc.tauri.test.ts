// @vitest-environment jsdom
/**
 * Desktop ask_ai: events arrive on a per-request Tauri channel, not as global
 * events. Channel messages are ordered among themselves but not against the
 * command's reply, so `invoke('ask_ai')` must resolve only once the channel
 * delivered its end marker — otherwise a tool call or `ai:done` that lands
 * after the reply is lost to the transport, which reads the turn right away.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const { tauriInvoke, tauriListen, channels } = vi.hoisted(() => {
  ;(window as any).__TAURI_INTERNALS__ = {}
  return { tauriInvoke: vi.fn(), tauriListen: vi.fn(), channels: [] as Array<{ onmessage: (message: unknown) => void }> }
})
vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriInvoke,
  Channel: class {
    onmessage: (message: unknown) => void
    constructor(onmessage: (message: unknown) => void) {
      this.onmessage = onmessage
      channels.push(this)
    }
  },
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: tauriListen }))

import { invoke, listen } from '../../../frontend/lib/ipc'

afterEach(() => {
  tauriInvoke.mockReset()
  tauriListen.mockReset()
  channels.length = 0
  vi.useRealTimers()
})

describe('desktop ask_ai channel', () => {
  it('re-emits channel events locally and resolves only after the end marker', async () => {
    const events: Array<[string, unknown]> = []
    const unlisten = await Promise.all(['ai:token', 'ai:tool_call', 'ai:done'].map(name =>
      listen(name, e => events.push([name, e.payload]))))
    // AI stream listeners stay local: no global Tauri listener per turn.
    expect(tauriListen).not.toHaveBeenCalled()

    tauriInvoke.mockImplementation(async (_cmd: string, args: { onEvent: { onmessage: (message: unknown) => void } }) => {
      args.onEvent.onmessage({ event: 'ai:token', payload: { requestId: 'r', token: 'hi' } })
      // The large tool call and the end marker land after the command reply.
      setTimeout(() => {
        args.onEvent.onmessage({ event: 'ai:tool_call', payload: { requestId: 'r', toolName: 'applyDocumentOperations' } })
        args.onEvent.onmessage({ event: 'ai:done', payload: { requestId: 'r', truncated: false } })
        args.onEvent.onmessage({ event: 'ai:end' })
      }, 20)
    })

    await invoke('ask_ai', { messages: '[]', requestId: 'r' })
    expect(events.map(([name]) => name)).toEqual(['ai:token', 'ai:tool_call', 'ai:done'])
    expect(tauriInvoke).toHaveBeenCalledWith('ask_ai', expect.objectContaining({ requestId: 'r', onEvent: channels[0] }))
    unlisten.forEach(fn => fn())
  })

  it('does not hang when the end marker never arrives', async () => {
    vi.useFakeTimers()
    tauriInvoke.mockResolvedValue(undefined)
    let settled = false
    const pending = invoke('ask_ai', { messages: '[]', requestId: 'r' }).then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(9_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1_500)
    await pending
    expect(settled).toBe(true)
  })

  it('rejects with the command error without waiting for the channel', async () => {
    tauriInvoke.mockRejectedValue('No API key found in keychain')
    await expect(invoke('ask_ai', { messages: '[]', requestId: 'r' })).rejects.toBe('No API key found in keychain')
  })

  it('keeps other events on the Tauri event system', async () => {
    tauriListen.mockResolvedValue(() => {})
    await listen('app:before-close', () => {})
    expect(tauriListen).toHaveBeenCalledWith('app:before-close', expect.any(Function))
  })
})
