import { afterEach, describe, expect, it, vi } from 'vitest'
import { invoke, listen } from '../../../frontend/lib/ipc'

function sseStream(chunks: Array<string | Uint8Array>) {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      controller.close()
    },
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('web IPC bridge', () => {
  it('re-emits SSE frames when network reads split UTF-8 and event data', async () => {
    const tokens: string[] = []
    const tools: unknown[] = []
    const done: unknown[] = []
    const unlistenToken = await listen<string>('ai:token', e => tokens.push(e.payload))
    const unlistenTool = await listen('ai:tool_call', e => tools.push(e.payload))
    const unlistenDone = await listen('ai:done', e => done.push(e.payload))
    const encoder = new TextEncoder()
    const tokenPrefix = encoder.encode('event: ai:token\r\ndata: "hello ')
    const emoji = encoder.encode('🌍')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(sseStream([
      tokenPrefix,
      emoji.slice(0, 1),
      emoji.slice(1),
      '"\r\n\r\n',
      'event: ai:tool_call\n',
      'data: {"toolCallId":"call-1","toolName":"applyDocumentOperations","input":{}}\n\n',
      'event: ai:done\n',
      'data: {"truncated":false}\n\n',
    ]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })))

    try {
      await invoke('ask_ai', { messages: '[]' })
      expect(tokens).toEqual(['hello 🌍'])
      expect(tools).toEqual([{ toolCallId: 'call-1', toolName: 'applyDocumentOperations', input: {} }])
      expect(done).toEqual([{ truncated: false }])
    } finally {
      unlistenToken()
      unlistenTool()
      unlistenDone()
    }
  })

  it('emits the auth event for unauthorized JSON requests', async () => {
    let unauthorized = 0
    const unlisten = await listen('auth:unauthorized', () => { unauthorized++ })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })))

    try {
      await expect(invoke('git_status')).rejects.toThrow('Unauthorized')
      expect(unauthorized).toBe(1)
    } finally {
      unlisten()
    }
  })
})
