import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

/** Serve SSE frames tagged with the request id the transport sent in the POST
 *  body. The transport filters events by that id, so a mock that omits it (or
 *  hardcodes one) would test a protocol the backend never speaks. */
function sseResponder(frames: (requestId: string) => string[]) {
  return vi.fn(async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { requestId?: string }
    return new Response(sseStream(frames(String(body.requestId ?? ''))), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  })
}

beforeEach(() => {
  useAiSettings.setState({ provider: '', model: '', probeTools: {} })
})

afterEach(() => vi.unstubAllGlobals())

describe('createAiTransport truncated response', () => {
  it('fails the stream when the server capped the response (ai:done truncated)', async () => {
    vi.stubGlobal('fetch', sseResponder((id) => [
      'event: ai:token\n',
      `data: {"requestId":"${id}","token":"partial content"}\n\n`,
      'event: ai:done\n',
      `data: {"requestId":"${id}","provider":"test","truncated":true}\n\n`,
    ]))

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
    vi.stubGlobal('fetch', sseResponder((id) => [
      'event: ai:token\n',
      `data: {"requestId":"${id}","token":"partial commentary"}\n\n`,
      'event: ai:tool_call\n',
      `data: {"requestId":"${id}","toolCallId":"call-1","toolName":"applyDocumentOperations","input":{"operations":[]}}\n\n`,
      'event: ai:tools_done\n',
      `data: {"requestId":"${id}"}\n\n`,
      'event: ai:done\n',
      `data: {"requestId":"${id}","provider":"deepseek","truncated":true}\n\n`,
    ]))

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

describe('createAiTransport request identity', () => {
  it('sends a request id and ignores events tagged with a different one', async () => {
    // Regression: every stream listened on the same global events, so tokens
    // from a superseded request (Stop then retry, or a commit-message turn)
    // were folded into whatever turn happened to be listening.
    useAiSettings.setState({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      probeTools: { deepseek: { 'deepseek-v4-flash': true } },
    })
    let sentRequestId = ''
    vi.stubGlobal('fetch', sseResponder((id) => {
      sentRequestId = id
      return [
        // Both stale and current tool calls are tagged differently; only the one
        // matching this turn's id may reach the editor.
        'event: ai:tool_call\n',
        'data: {"requestId":"a-stale-turn","toolCallId":"stale","toolName":"applyDocumentOperations","input":{"operations":[]}}\n\n',
        'event: ai:tool_call\n',
        `data: {"requestId":"${id}","toolCallId":"mine","toolName":"applyDocumentOperations","input":{"operations":[{"type":"update","id":"b1","block":"<p>hi</p>"}]}}\n\n`,
        'event: ai:tools_done\n',
        `data: {"requestId":"${id}"}\n\n`,
        'event: ai:done\n',
        `data: {"requestId":"${id}","provider":"deepseek","truncated":false}\n\n`,
      ]
    }))
    // Editor that resolves the one valid block id, so the turn succeeds and the
    // emitted tool part is observable. HTML rendering mirrors the requested
    // content so the operation reads as a real change.
    const editor = {
      document: [{ id: 'b1', type: 'paragraph', content: 'before' }],
      getBlock: (id: string) => (id === 'b1' ? { id: 'b1' } : undefined),
      getSelection: () => undefined,
      blocksToMarkdownLossy: () => '',
      blocksToHTMLLossy: (blocks: any[]) => `<p>${blocks?.[0]?.content ?? ''}</p>`,
      tryParseHTMLToBlocks: (html: string) => [
        { type: 'paragraph', content: html.replace(/^<p>|<\/p>$/g, '') },
      ],
    }

    const transport = createAiTransport({ getEditor: () => editor })
    const stream = await transport.sendMessages({
      messages: [{ role: 'user', content: 'edit' }],
      body: { toolDefinitions: { applyDocumentOperations: { description: 'Edit doc', inputSchema: {} } } },
    })

    const reader = stream.getReader()
    const parts: any[] = []
    for (;;) {
      try {
        const result = await reader.read()
        if (result.done) break
        parts.push(result.value)
      } catch {
        break
      }
    }
    expect(sentRequestId).not.toBe('')
    const toolCalls = parts.filter(p => p.type === 'tool-input-available')
    expect(toolCalls.map(p => p.input.operations.length)).toEqual([1])
    // The stale call was ignored, not merged in alongside the current one.
    expect(parts.some(p => JSON.stringify(p).includes('stale'))).toBe(false)
  })

  it('mints a new request id for every internal retry attempt', async () => {
    // A semantic-validation retry re-asks the provider; the ids must differ or
    // late events from attempt N would still be attributed to attempt N+1.
    const ids: string[] = []
    vi.stubGlobal('fetch', sseResponder((id) => {
      ids.push(id)
      return [
        'event: ai:tool_call\n',
        // Unknown block id → semantic validation rejects → transport retries.
        `data: {"requestId":"${id}","toolCallId":"call-1","toolName":"applyDocumentOperations","input":{"operations":[{"type":"update","id":"missing-block","block":"<p>x</p>"}]}}\n\n`,
        'event: ai:tools_done\n',
        `data: {"requestId":"${id}"}\n\n`,
        'event: ai:done\n',
        `data: {"requestId":"${id}","provider":"test","truncated":false}\n\n`,
      ]
    }))
    // tools mode needs a probed provider so the retry path is exercised.
    useAiSettings.setState({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      probeTools: { deepseek: { 'deepseek-v4-flash': true } },
    })
    const editor = {
      document: [],
      getBlock: () => undefined,
      getSelection: () => undefined,
      blocksToMarkdownLossy: () => '',
    }

    const transport = createAiTransport({ getEditor: () => editor })
    const stream = await transport.sendMessages({
      messages: [{ role: 'user', content: 'edit' }],
      body: { toolDefinitions: { applyDocumentOperations: { description: 'Edit doc', inputSchema: {} } } },
    })
    const reader = stream.getReader()
    for (;;) {
      try {
        const r = await reader.read()
        if (r.done) break
      } catch {
        break
      }
    }

    expect(ids.length).toBeGreaterThan(1)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

/** Path A / Path B asymmetry: a provider that probed as tool-capable may still
 *  answer with prose. Path A used to reject that outright ("AI tool call
 *  required"), even though the text-only path could have handled it. */
describe('createAiTransport tools-to-text fallback', () => {
  /** Tool-capable provider + tool definitions → Path A. */
  const usePathA = () => {
    useAiSettings.setState({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      probeTools: { deepseek: { 'deepseek-v4-flash': true } },
    })
  }
  /** Minimal BlockNote-ish editor. A document with one real block + cursor is
   *  required: Path B anchors its `add` op on the cursor block, and a missing
   *  block would yield an `undefined$` referenceId that is filtered out as a
   *  no-op — hiding the conversion this suite exists to verify. */
  const editor = () => ({
    document: [{ id: 'b1', type: 'paragraph', content: 'existing' }],
    getBlock: (id: string) => (id === 'b1' ? { id: 'b1', content: [] } : undefined),
    getSelection: () => undefined,
    getTextCursorPosition: () => ({ block: { id: 'b1', content: [] } }),
    blocksToMarkdownLossy: () => '',
    blocksToHTMLLossy: (blocks: any[]) => `<p>${blocks?.[0]?.content ?? ''}</p>`,
    tryParseHTMLToBlocks: (html: string) => [
      { type: 'paragraph', content: html.replace(/^<p>|(<\/p>)$/g, '') },
    ],
    tryParseMarkdownToBlocks: async (markdown: string) => [
      { type: 'paragraph', content: markdown },
    ],
  })
  const drain = async (transport: any) => {
    const stream = await transport.sendMessages({
      messages: [{ role: 'user', content: 'summarise this document' }],
      body: { toolDefinitions: { applyDocumentOperations: { description: 'Edit doc', inputSchema: {} } } },
    })
    const reader = stream.getReader()
    const parts: any[] = []
    let error: unknown = null
    for (;;) {
      try {
        const r = await reader.read()
        if (r.done) break
        parts.push(r.value)
      } catch (e) {
        error = e
        break
      }
    }
    return { parts, error }
  }

  it('re-asks once as text-only when tools mode returns prose, then maps the markdown', async () => {
    usePathA()
    const requests: Array<{ requestId: string; hasTools: boolean; mode: string }> = []
    vi.stubGlobal('fetch', sseResponder((id) => {
      // Attempt 1 (Path A): prose, no tool call. Attempt 2 (Path B): markdown.
      const attempt = requests.length
      requests.push({ requestId: id, hasTools: false, mode: '' })
      return attempt === 0
        ? [
            'event: ai:token\n',
            `data: {"requestId":"${id}","token":"I cannot edit this document."}\n\n`,
            'event: ai:done\n',
            `data: {"requestId":"${id}","provider":"deepseek","truncated":false}\n\n`,
          ]
        : [
            'event: ai:token\n',
            `data: {"requestId":"${id}","token":"<content>## Summary\\n\\nAll good.</content>"}\n\n`,
            'event: ai:done\n',
            `data: {"requestId":"${id}","provider":"deepseek","truncated":false}\n\n`,
          ]
    }))

    const { parts, error } = await drain(createAiTransport({ getEditor: editor }))

    // Exactly one fallback: the provider answered prose once, then markdown.
    expect(requests.length).toBe(2)
    // The fallback must be a genuinely different request (new identity, no tools).
    expect(requests[1].requestId).not.toBe(requests[0].requestId)
    expect(error).toBeNull()
    const toolParts = parts.filter(p => p.type === 'tool-input-available')
    expect(toolParts.length).toBe(1)
    expect(toolParts[0].toolName).toBe('applyDocumentOperations')
    // Text-mode output streams live rather than being buffered for the end.
    // Text-mode output streams live rather than being buffered for the end.
    expect(parts.some(p => p.type === 'text-delta')).toBe(true)
    // The tool-mode prose is never promoted into the document.
    expect(JSON.stringify(parts)).not.toContain('I cannot edit this document')
  })

  it('never writes a text-mode reply that carries no delimited payload', async () => {
    // Regression: Path B treated every reply as document content, so a model
    // that answered instead of editing ("No spelling errors in document…") had
    // its prose mapped to operations — replacing the selection, or landing
    // after the cursor. Commentary must leave the document untouched.
    usePathA()
    vi.stubGlobal('fetch', sseResponder((id) => [
      'event: ai:token\n',
      `data: {"requestId":"${id}","token":"No spelling errors in document. Checked heading, prose, code comments. All correct."}\n\n`,
      'event: ai:done\n',
      `data: {"requestId":"${id}","provider":"deepseek","truncated":false}\n\n`,
    ]))
    const doc = [{ id: 'b1', type: 'paragraph', content: 'teh quick brown fox' }]
    const edited = { ...editor(), document: doc }

    const { parts, error } = await drain(createAiTransport({ getEditor: () => edited }))

    // The consumer writes to the editor only for a `tool-input-available` part
    // (`readPart` → `applyOperations`), so its absence is exactly "the document was
    // left alone". Without the payload gate this part carried the prose.
    expect(parts.filter(p => p.type === 'tool-input-available').length).toBe(0)
    // It surfaces through the existing no-change surface instead of succeeding.
    expect(String(error)).toContain('no document changes')
  })

  it('maps a delimited payload even when the model wraps it in explanation', async () => {
    usePathA()
    let calls = 0
    vi.stubGlobal('fetch', sseResponder((id) => {
      calls++
      return calls === 1
        ? [
            'event: ai:token\n',
            `data: {"requestId":"${id}","token":"I cannot call tools."}\n\n`,
            'event: ai:done\n',
            `data: {"requestId":"${id}","provider":"deepseek","truncated":false}\n\n`,
          ]
        : [
            'event: ai:token\n',
            `data: {"requestId":"${id}","token":"Sure, here it is:\\n<content>## Summary\\n\\nAll good.</content>\\nHope that helps."}\n\n`,
            'event: ai:done\n',
            `data: {"requestId":"${id}","provider":"deepseek","truncated":false}\n\n`,
          ]
    }))

    const { parts, error } = await drain(createAiTransport({ getEditor: editor }))

    expect(error).toBeNull()
    const toolParts = parts.filter(p => p.type === 'tool-input-available')
    expect(toolParts.length).toBe(1)
    // Only the payload is written — the preamble and the sign-off are not.
    const written = JSON.stringify(toolParts[0].input)
    expect(written).toContain('All good.')
    expect(written).not.toContain('Sure, here it is')
    expect(written).not.toContain('Hope that helps')
  })

  it('never loops: a second prose answer ends the turn after the one fallback', async () => {
    usePathA()
    let calls = 0
    vi.stubGlobal('fetch', sseResponder((id) => {
      calls++
      return [
        // Prose in BOTH modes → the fallback must not re-trigger itself.
        'event: ai:token\n',
        `data: {"requestId":"${id}","token":"Still just prose."}\n\n`,
        'event: ai:done\n',
        `data: {"requestId":"${id}","provider":"deepseek","truncated":false}\n\n`,
      ]
    }))

    const { parts } = await drain(createAiTransport({ getEditor: editor }))

    // Two attempts total (Path A + exactly one Path B fallback), never more.
    expect(calls).toBe(2)
    // The turn terminates on its own — the fallback never re-arms itself.
    expect(parts.filter(p => p.type === 'tool-input-available').length).toBeLessThanOrEqual(1)
    expect(parts.filter(p => p.type === 'text-start').length).toBe(1)
  })

  it('does not fall back when the tools attempt produced meaningful operations', async () => {
    usePathA()
    let calls = 0
    const document = [{ id: 'b1', type: 'paragraph', content: 'before' }]
    const block = { id: 'b1' }
    vi.stubGlobal('fetch', sseResponder((id) => {
      calls++
      return [
        'event: ai:token\n',
        `data: {"requestId":"${id}","token":"commentary"}\n\n`,
        'event: ai:tool_call\n',
        `data: {"requestId":"${id}","toolCallId":"c1","toolName":"applyDocumentOperations","input":{"operations":[{"type":"update","id":"b1","block":"<p>after</p>"}]}}\n\n`,
        'event: ai:tools_done\n',
        `data: {"requestId":"${id}"}\n\n`,
        'event: ai:done\n',
        `data: {"requestId":"${id}","provider":"deepseek","truncated":false}\n\n`,
      ]
    }))

    const toolsEditor = {
      document,
      getBlock: (id: string) => (id === 'b1' ? block : undefined),
      getSelection: () => undefined,
      blocksToMarkdownLossy: () => '',
      blocksToHTMLLossy: (blocks: any[]) => `<p>${blocks?.[0]?.content ?? ''}</p>`,
      tryParseHTMLToBlocks: (html: string) => [
        { type: 'paragraph', content: html.replace(/^<p>|<\/p>$/g, '') },
      ],
    }

    const { parts } = await drain(createAiTransport({ getEditor: () => toolsEditor }))

    // Tool output wins — no wasted second request.
    expect(calls).toBe(1)
    expect(parts.filter(p => p.type === 'tool-input-available').length).toBe(1)
  })
})

describe('createAiTransport writing-started marker', () => {
  /** Tool-capable provider + tool definitions → Path A, where the provider writes
   *  the operations inside the tool call rather than as streamed prose. */
  const usePathA = () => {
    useAiSettings.setState({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      probeTools: { deepseek: { 'deepseek-v4-flash': true } },
    })
  }
  const toolsEditor = () => ({
    document: [{ id: 'b1', type: 'paragraph', content: 'before' }],
    getBlock: (id: string) => (id === 'b1' ? { id: 'b1' } : undefined),
    getSelection: () => undefined,
    getTextCursorPosition: () => ({ block: { id: 'b1', content: [] } }),
    blocksToMarkdownLossy: () => '',
    blocksToHTMLLossy: (blocks: any[]) => `<p>${blocks?.[0]?.content ?? ''}</p>`,
    tryParseHTMLToBlocks: (html: string) => [
      { type: 'paragraph', content: html.replace(/^<p>|<\/p>$/g, '') },
    ],
    tryParseMarkdownToBlocks: async (markdown: string) => [
      { type: 'paragraph', content: markdown },
    ],
  })

  const drainTypes = async () => {
    const stream = await createAiTransport({ getEditor: toolsEditor }).sendMessages({
      messages: [{ role: 'user', content: 'edit the document' }],
      body: { toolDefinitions: { applyDocumentOperations: { description: 'Edit doc', inputSchema: {} } } },
    })
    const reader = stream.getReader()
    const types: string[] = []
    for (;;) {
      try {
        const r = await reader.read()
        if (r.done) break
        types.push(r.value?.type)
      } catch {
        break
      }
    }
    return types
  }

  it('surfaces ai:generating before the completed tool call', async () => {
    usePathA()
    vi.stubGlobal('fetch', sseResponder((id) => [
      'event: ai:token\n',
      `data: {"requestId":"${id}","token":"commentary"}\n\n`,
      'event: ai:generating\n',
      `data: {"requestId":"${id}"}\n\n`,
      'event: ai:tool_call\n',
      `data: {"requestId":"${id}","toolCallId":"c1","toolName":"applyDocumentOperations","input":{"operations":[{"type":"update","id":"b1","block":"<p>after</p>"}]}}\n\n`,
      'event: ai:tools_done\n',
      `data: {"requestId":"${id}"}\n\n`,
      'event: ai:done\n',
      `data: {"requestId":"${id}","provider":"deepseek","truncated":false}\n\n`,
    ]))

    const types = await drainTypes()

    // The marker precedes the ops: the menu can say "writing" while the model is
    // still producing the call, not only when it lands.
    expect(types).toContain('writing-started')
    expect(types.indexOf('writing-started')).toBeLessThan(types.indexOf('tool-input-available'))
  })

  it('emits no marker when the backend sends no ai:generating event', async () => {
    // Rust signals on the first non-empty delta of either kind, so a prose turn
    // carries the event too. This guards the transport from inventing the marker
    // client-side (tokens alone must not flip the label).
    vi.stubGlobal('fetch', sseResponder((id) => [
      'event: ai:token\n',
      `data: {"requestId":"${id}","token":"## Heading\\n\\nProse only."}\n\n`,
      'event: ai:done\n',
      `data: {"requestId":"${id}","provider":"deepseek","truncated":false}\n\n`,
    ]))

    const types = await drainTypes()

    expect(types).not.toContain('writing-started')
  })
})
