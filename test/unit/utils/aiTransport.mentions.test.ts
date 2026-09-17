import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAiTransport } from '../../../frontend/utils/aiTransport'
import { useAiChat } from '../../../frontend/stores/aiChat'
import { useAiSettings } from '../../../frontend/stores/aiSettings'

/** Mention retrieval is a dedicated API: it must fire ONLY when the prompt
 *  actually contains a mention, and its payload must reach the model as framed
 *  vault reference data. These tests drive the real transport over the web
 *  adapter (fetch), so the wiring — not just the helpers — is covered. */

const BUNDLE = {
  files: [{ path: 'docs/a.md', content: 'REFERENCE BODY', bytes: 14, truncated: false, via: 'mention' }],
  skipped: [],
  totals: { files: 1, chars: 14, truncated: 0 },
}

function sseStream(chunks: string[]) {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

type Captured = { url: string; body: any }

function captureFetch() {
  const calls: Captured[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined })
    if (String(url).includes('resolve_mentions')) {
      return new Response(JSON.stringify({ result: JSON.stringify(BUNDLE) }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(sseStream([
      'event: ai:token\n',
      'data: "ok"\n\n',
      'event: ai:done\n',
      'data: {"provider":"test","truncated":false}\n\n',
    ]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }))
  return calls
}

async function send(content: string) {
  const calls = captureFetch()
  const transport = createAiTransport({ getEditor: () => null, filePath: 'notes/current.md' })
  const stream = await transport.sendMessages({ messages: [{ role: 'user', content }], body: {} })
  const reader = stream.getReader()
  for (;;) {
    try {
      const result = await reader.read()
      if (result.done) break
    } catch {
      break
    }
  }
  const resolveCalls = calls.filter(call => call.url.includes('resolve_mentions'))
  const askCall = calls.find(call => call.url.includes('ask_ai'))!
  return { resolveCalls, messages: JSON.parse(askCall.body.messages) as { role: string; content: string }[] }
}

beforeEach(() => {
  useAiSettings.setState({ provider: 'test', model: 'test-model', probeTools: {} })
  useAiChat.setState({ mentionNotice: null })
})

afterEach(() => vi.unstubAllGlobals())

describe('transport mention retrieval', () => {
  it('does zero retrieval work and sends no vault context when the prompt has no mention', async () => {
    const { resolveCalls, messages } = await send('rewrite this paragraph')

    expect(resolveCalls).toHaveLength(0)
    expect(messages.some(message => message.content.includes('<vault_context>'))).toBe(false)
    expect(useAiChat.getState().mentionNotice).toBeNull()
  })

  it('resolves a mentioned file and injects its content before the user turn', async () => {
    const { resolveCalls, messages } = await send('summarise @docs/a.md')

    expect(resolveCalls).toHaveLength(1)
    expect(resolveCalls[0].body.request.mentions).toEqual([{ token: 'docs/a.md', kind: 'file' }])
    // The active document is never re-read as a mention of itself.
    expect(resolveCalls[0].body.request.excludePath).toBe('notes/current.md')

    const injected = messages.findIndex(message => message.content.includes('<vault_context>'))
    expect(injected).toBeGreaterThan(-1)
    expect(messages[injected].content).toContain('REFERENCE BODY')
    expect(messages[injected].content).toContain('untrusted reference data')
    expect(messages[injected + 1].role).toBe('user')
    expect(useAiChat.getState().mentionNotice).toBe('1 file in context')
  })

  it('degrades to no context when the mention payload is not valid JSON', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
      urls.push(String(url))
      if (String(url).includes('resolve_mentions')) {
        return new Response(JSON.stringify({ result: 'not-json' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(sseStream([
        'event: ai:token\n',
        'data: "ok"\n\n',
        'event: ai:done\n',
        'data: {"provider":"test","truncated":false}\n\n',
      ]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }))
    const transport = createAiTransport({ getEditor: () => null, filePath: 'notes/current.md' })
    const reader = (await transport.sendMessages({ messages: [{ role: 'user', content: 'summarise @docs/a.md' }], body: {} })).getReader()
    for (;;) {
      try {
        const result = await reader.read()
        if (result.done) break
      } catch {
        break
      }
    }

    // A bad payload is optional context, not a failed turn.
    expect(urls.some(url => url.includes('ask_ai'))).toBe(true)
    expect(useAiChat.getState().mentionNotice).toBeNull()
  })
})
