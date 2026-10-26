// @vitest-environment jsdom
/**
 * Selection scope, end to end on a real BlockNote editor: what the model is
 * shown as "the selection" and what the result overwrites must be the same
 * text, in both paths. Before: Path A replaced whole blocks for a selection
 * that started or ended mid-block (dropping the unselected text), and Path B
 * showed the model whole blocks but wrote into the selected range only
 * (duplicating the unselected text).
 */
import { BlockNoteEditor } from '@blocknote/core'
import { TextSelection } from 'prosemirror-state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSchema } from '../../../frontend/components/editor/setup'
import { buildHtmlDocumentState, captureAISelection, createSelectionAwareDocumentStateBuilder, openAIMenuAtAnchor } from '../../../frontend/utils/aiBlocks'
import { AIExtension } from '../../../frontend/utils/aiExtension'
import { createAiTransport } from '../../../frontend/utils/aiTransport'
import { useAiSettings } from '../../../frontend/stores/aiSettings'
import { resetToolProbeBackoff } from '../../../frontend/utils/aiProbe'

vi.mock('../../../frontend/utils/softKeyboard', () => ({ softKeyboardOnFocus: vi.fn(() => false) }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }))

let editor: any

beforeEach(() => resetToolProbeBackoff())
afterEach(() => {
  editor?.unmount()
  editor = undefined
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function mount(content: any[] = [
  { id: 'a', type: 'paragraph', content: 'alpha beta gamma' },
  { id: 'b', type: 'paragraph', content: 'second paragraph' },
]) {
  editor = BlockNoteEditor.create({ schema: getSchema() as any, initialContent: content })
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  return editor
}

function pos(ed: any, id: string, text: string) {
  let blockPos = -1
  ed.prosemirrorView.state.doc.descendants((node: any, at: number) => {
    if (node.attrs?.id !== id) return true
    blockPos = at
    return false
  })
  return blockPos + 2 + ed.prosemirrorView.state.doc.nodeAt(blockPos).firstChild.textContent.indexOf(text)
}

function select(ed: any, from: number, to: number) {
  ed.transact((tr: any) => tr.setSelection(TextSelection.create(tr.doc, from, to)))
}

/** Attach the extension the way the editor factory does, then run one prompt. */
async function prompt(ed: any, transport: any, userPrompt: string, useSelection: boolean) {
  const ai: any = (AIExtension as any)({
    transport,
    documentStateBuilder: createSelectionAwareDocumentStateBuilder(async (request: any) =>
      buildHtmlDocumentState(request.editor, !!request.selectedBlocks?.length)),
  })({ editor: ed })
  const getExtension = ed.getExtension.bind(ed)
  ed.getExtension = (name: string) => (name === 'ai' ? ai : getExtension(name))
  if (useSelection) captureAISelection(ed)
  openAIMenuAtAnchor(ed)
  await ai.invokeAI({ userPrompt, useSelection })
  return ai
}

/** A transport that answers with fixed operations, recording what it was sent. */
function operationsTransport(operations: any[] | ((request: any) => any[])) {
  const requests: any[] = []
  return {
    requests,
    sendMessages: vi.fn(async (request: any) => {
      requests.push(request)
      const input = { operations: typeof operations === 'function' ? operations(request) : operations }
      return new ReadableStream({ start(controller) { controller.enqueue({ type: 'tool-input-available', input }); controller.close() } })
    }),
  }
}

const markdown = async (ed: any) => (await ed.blocksToMarkdownLossy(ed.document)).trim()

describe('applying a result to a selection', () => {
  it('rewrites only the selected text of each block a multi-block selection cuts through', async () => {
    const ed = mount()
    select(ed, pos(ed, 'a', 'beta'), pos(ed, 'b', 'second') + 'second'.length)
    const transport = operationsTransport([
      { type: 'update', id: 'a$', block: '<p>BETA GAMMA</p>' },
      { type: 'update', id: 'b$', block: '<p>SECOND</p>' },
    ])
    const ai = await prompt(ed, transport, 'uppercase', true)

    // The model was shown the cut: only the selected part of each block.
    const state = transport.requests[0].messages[0].metadata.documentState
    expect(state.selectedBlocks.map((block: any) => block.block)).toEqual(['<p>beta gamma</p>', '<p>second</p>'])
    expect(ai.store.state.aiMenuState.status).toBe('user-reviewing')
    expect(await markdown(ed)).toBe('alpha BETA GAMMA\n\nSECOND paragraph')
  })

  it('deletes only the selected text of a partly selected block, and a fully selected block whole', async () => {
    const ed = mount([
      { id: 'a', type: 'paragraph', content: 'keep remove' },
      { id: 'b', type: 'paragraph', content: 'whole block' },
      { id: 'c', type: 'paragraph', content: 'tail' },
    ])
    select(ed, pos(ed, 'a', ' remove'), pos(ed, 'b', 'block') + 'block'.length)
    await prompt(ed, operationsTransport([
      { type: 'delete', id: 'a$' },
      { type: 'delete', id: 'b$' },
    ]), 'delete this', true)
    expect(await markdown(ed)).toBe('keep\n\ntail')
  })

  it('keeps a fully selected heading a heading when the result is a plain paragraph', async () => {
    const ed = mount([{ id: 'h', type: 'heading', props: { level: 2 }, content: 'Old title' }])
    select(ed, pos(ed, 'h', 'Old title'), pos(ed, 'h', 'Old title') + 'Old title'.length)
    await prompt(ed, operationsTransport([{ type: 'update', id: 'h$', block: '<p>New title</p>' }]), 'rewrite', true)
    expect(await markdown(ed)).toBe('## New title')
  })

  it('keeps the props of a fully selected block whose result changes them but not the type', async () => {
    const ed = mount([{ id: 'h', type: 'heading', props: { level: 2 }, content: 'Old title' }])
    select(ed, pos(ed, 'h', 'Old title'), pos(ed, 'h', 'Old title') + 'Old title'.length)
    await prompt(ed, operationsTransport([{ type: 'update', id: 'h$', block: '<h3>New title</h3>' }]), 'demote', true)
    expect(await markdown(ed)).toBe('### New title')
  })

  it('converts a fully selected block when the result deliberately changes its type', async () => {
    const ed = mount([{ id: 'p', type: 'paragraph', content: 'Make me a heading' }])
    select(ed, pos(ed, 'p', 'Make'), pos(ed, 'p', 'heading') + 'heading'.length)
    await prompt(ed, operationsTransport([{ type: 'update', id: 'p$', block: '<h2>Make me a heading</h2>' }]), 'turn into a heading', true)
    expect(await markdown(ed)).toBe('## Make me a heading')
  })

  it('does not let a selection left by an earlier request redirect a cursor request', async () => {
    const ed = mount()
    select(ed, pos(ed, 'a', 'beta'), pos(ed, 'a', 'beta') + 'beta'.length)
    captureAISelection(ed)
    // Cursor request: its update replaces the whole block it names.
    select(ed, pos(ed, 'b', 'second'), pos(ed, 'b', 'second'))
    await prompt(ed, operationsTransport([{ type: 'update', id: 'a$', block: '<p>replaced</p>' }]), 'rewrite the first paragraph', false)
    expect(await markdown(ed)).toBe('replaced\n\nsecond paragraph')
  })
})

describe('one scope for both paths (real transport)', () => {
  function sse(requestId: string, frames: Array<[string, unknown]>) {
    const encoder = new TextEncoder()
    return new Response(new ReadableStream({
      start(controller) {
        for (const [event, payload] of frames) {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify({ requestId, ...(payload as object) })}\n\n`))
        }
        controller.close()
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  it('Path B shows the model only the selected text and writes its answer there', async () => {
    useAiSettings.setState({ provider: 'deepseek', model: 'm', probeTools: { deepseek: { m: false } }, savedProviders: ['deepseek'] })
    const ed = mount()
    let selectedText = ''
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      const context = JSON.parse(body.messages).map((message: any) => String(message.content)).join('\n')
      selectedText = context.split('Latest selected text:\n')[1]?.split('\n\n')[0]?.trim() ?? ''
      return sse(body.requestId, [
        ['ai:token', { token: `<content>${selectedText.toUpperCase()}</content>` }],
        ['ai:done', { provider: 'deepseek', truncated: false }],
      ])
    }))
    select(ed, pos(ed, 'a', 'beta'), pos(ed, 'a', 'beta') + 'beta'.length)
    const ai = await prompt(ed, createAiTransport({ getEditor: () => ed }), 'make it uppercase', true)

    expect(selectedText).toBe('beta')
    expect(ai.store.state.aiMenuState.status).toBe('user-reviewing')
    expect(await markdown(ed)).toBe('alpha BETA gamma\n\nsecond paragraph')
  })

  it('Path A rejects an operation outside the selection and retries against the selection', async () => {
    useAiSettings.setState({ provider: 'deepseek', model: 'm', probeTools: { deepseek: { m: true } }, savedProviders: ['deepseek'] })
    const ed = mount()
    const prompts: string[] = []
    let attempt = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      prompts.push(JSON.parse(body.messages).map((message: any) => String(message.content)).join('\n'))
      attempt++
      // Attempt 1 reaches into block `b`, which is not selected.
      const operations = attempt === 1
        ? [{ type: 'update', id: 'b$', block: '<p>hijacked</p>' }]
        : [{ type: 'update', id: 'a$', block: '<p>BETA</p>' }]
      return sse(body.requestId, [
        ['ai:tool_call', { toolCallId: 'tool-0', providerToolCallId: `p-${attempt}`, toolName: 'applyDocumentOperations', input: { operations } }],
        ['ai:done', { provider: 'deepseek', truncated: false }],
      ])
    }))
    select(ed, pos(ed, 'a', 'beta'), pos(ed, 'a', 'beta') + 'beta'.length)
    const ai = await prompt(ed, createAiTransport({ getEditor: () => ed }), 'uppercase', true)

    expect(attempt).toBe(2)
    expect(prompts[1]).toContain('An operation targets a block outside the selection')
    expect(prompts[1]).toContain('Use ONLY the selected blocks')
    expect(ai.store.state.aiMenuState.status).toBe('user-reviewing')
    expect(await markdown(ed)).toBe('alpha BETA gamma\n\nsecond paragraph')
  })
})
