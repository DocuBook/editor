import { afterEach, describe, expect, it, vi } from 'vitest'
import { invoke, listen, isAbsoluteUrl, isSafeImageUrl } from '../../../frontend/lib/ipc'

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

describe('isAbsoluteUrl', () => {
  it('keeps absolute and protocol-relative URLs out of the vault resolution', () => {
    // External images in markdown (badges, shields.io, skillicons, raw.githubusercontent).
    expect(isAbsoluteUrl('https://skillicons.dev/icons?i=tailwindcss,react')).toBe(true)
    expect(isAbsoluteUrl('https://img.shields.io/badge/Facebook-1877F2?style=for-the-badge')).toBe(true)
    expect(isAbsoluteUrl('https://raw.githubusercontent.com/a/b/output/graph.svg')).toBe(true)
    expect(isAbsoluteUrl('http://example.com/a.png')).toBe(true)
    expect(isAbsoluteUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(true)
    expect(isAbsoluteUrl('blob:https://editor.wildan.dev/uuid')).toBe(true)
    expect(isAbsoluteUrl('//cdn.example.com/a.png')).toBe(true)
  })

  it('keeps vault-relative paths as vault-relative', () => {
    expect(isAbsoluteUrl('images/logo.png')).toBe(false)
    expect(isAbsoluteUrl('logo.png')).toBe(false)
    expect(isAbsoluteUrl('./img/a.png')).toBe(false)
    expect(isAbsoluteUrl('../shared/b.png')).toBe(false)
  })
})

describe('isSafeImageUrl', () => {
  it('allows https, data, blob, protocol-relative, and vault-relative images', () => {
    expect(isSafeImageUrl('https://skillicons.dev/icons?i=tailwindcss,react')).toBe(true)
    expect(isSafeImageUrl('https://img.shields.io/badge/Facebook-1877F2?style=for-the-badge')).toBe(true)
    expect(isSafeImageUrl('//cdn.example.com/a.png')).toBe(true)
    expect(isSafeImageUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(true)
    expect(isSafeImageUrl('blob:https://editor.wildan.dev/uuid')).toBe(true)
    expect(isSafeImageUrl('images/logo.png')).toBe(true) // vault-relative → ACL
  })

  it('rejects script-capable, local-file, and plaintext-http schemes', () => {
    expect(isSafeImageUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeImageUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeImageUrl('vbscript:msgbox(1)')).toBe(false)
    expect(isSafeImageUrl('http://example.com/a.png')).toBe(false) // https-only for remote
  })
})

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

  it('drops an incomplete trailing frame instead of emitting partial content', async () => {
    const tokens: string[] = []
    const unlisten = await listen<string>('ai:token', e => tokens.push(e.payload))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(sseStream([
      'event: ai:token\r\n',
      'data: "complete"\r\n\r\n',
      'event: ai:token\r\n',
      'data: "trunca', // connection died mid-frame: no trailing blank line
    ]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })))

    try {
      await invoke('ask_ai', { messages: '[]' })
      expect(tokens).toEqual(['complete'])
    } finally {
      unlisten()
    }
  })

  it('rejects when a frame payload is not valid JSON (corrupt stream)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(sseStream([
      'event: ai:token\n',
      'data: "ok"\n\n',
      'event: ai:token\n',
      'data: "broken\n\n', // unterminated JSON string = cut mid-frame
    ]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })))

    await expect(invoke('ask_ai', { messages: '[]' })).rejects.toThrow('stream was interrupted')
  })
})
