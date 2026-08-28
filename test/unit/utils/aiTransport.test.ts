import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAiTransport } from '../../../frontend/utils/aiTransport'
import { useAiSettings } from '../../../frontend/stores/aiSettings'

function sseStream(chunks: string[]) {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('createAiTransport truncated response', () => {
  it('fails the stream when the server capped the response (ai:done truncated)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(sseStream([
      'event: ai:token\n',
      'data: "partial content"\n\n',
      'event: ai:done\n',
      'data: {"provider":"test","truncated":true}\n\n',
    ]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })))

    const transport = createAiTransport({ getEditor: () => null })
    const stream = await transport.sendMessages({
      messages: [{ role: 'user', content: 'write a very long document' }],
      body: {},
    })

    const reader = stream.getReader()
    const parts: any[] = []
    let sawError = false
    for (;;) {
      try {
        const r = await reader.read()
        if (r.done) break
        parts.push(r.value)
      } catch (e) {
        sawError = true
        expect(String(e)).toContain('truncated')
        break
      }
    }
    // At least one part was produced (stream started), and the transport
    // surfaced the truncation instead of promoting partial content.
    expect(parts.some(p => p.type === 'text-start')).toBe(true)
    expect(sawError).toBe(true)
  })

  it('path A (tools mode) fails without promoting partial tool calls or buffered text when truncated', async () => {
    useAiSettings.setState({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      probeTools: { deepseek: { 'deepseek-v4-flash': true } },
    })
    // Path A: server sends complete token + tool_call, then truncates.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(sseStream([
      'event: ai:token\n',
      'data: "partial commentary"\n\n',
      'event: ai:tool_call\n',
      'data: {"toolCallId":"call-1","toolName":"applyDocumentOperations","input":{"operations":[]}}\n\n',
      'event: ai:tools_done\n',
      'data: ""\n\n',
      'event: ai:done\n',
      'data: {"provider":"deepseek","truncated":true}\n\n',
    ]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })))

    const transport = createAiTransport({ getEditor: () => null })
    const stream = await transport.sendMessages({
      messages: [{ role: 'user', content: 'edit the document' }],
      body: {
        toolDefinitions: {
          applyDocumentOperations: { description: 'Edit doc', inputSchema: {} },
        },
      },
    })

    const reader = stream.getReader()
    const parts: any[] = []
    let sawError = false
    for (;;) {
      try {
        const r = await reader.read()
        if (r.done) break
        parts.push(r.value)
      } catch (e) {
        sawError = true
        expect(String(e)).toContain('truncated')
        break
      }
    }
    expect(sawError).toBe(true)
    // Partial tool calls / buffered text must never be promoted as output.
    expect(parts.some(p => p.type === 'tool-input-available')).toBe(false)
    expect(parts.some(p => p.type === 'text-delta')).toBe(false)
  })
})
