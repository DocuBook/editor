import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIExtension } from '../../../frontend/utils/aiExtension'

/** An AI result is saved only once the user keeps it. Until then the page's
 *  save baseline is the document the request started from, so autosave, a
 *  tab close or a crash during review never persist an unaccepted result. */

type Block = { id: string; type: string; content: string }

function streamOf(...inputs: any[]) {
  return new ReadableStream({
    start(controller) {
      for (const input of inputs) controller.enqueue({ type: 'tool-input-available', input })
      controller.close()
    },
  })
}

const update = (id: string, text: string) => ({ type: 'update', id, block: `<p>${text}</p>` })

function setup(streams: ReadableStream[]) {
  const editor = {
    document: [{ id: 'b1', type: 'paragraph', content: 'original' }] as Block[],
    headless: false,
    isEditable: true,
    prosemirrorView: { isDestroyed: false, state: { doc: { content: { size: 10 }, descendants: () => {} } }, dispatch: vi.fn() },
    getBlock(id: string) { return this.document.find(b => b.id === id) },
    getSelection: () => undefined,
    getExtension: () => undefined,
    tryParseHTMLToBlocks: (html: string) => [{ type: 'paragraph', content: html.replace(/<\/?p>/g, '') }],
    transact: (callback: () => void) => callback(),
    updateBlock(id: string, block: { content: string }) {
      this.document = this.document.map(b => (b.id === id ? { ...b, content: block.content } : b))
    },
    replaceBlocks: vi.fn(function (this: any, _ids: string[], blocks: Block[]) { this.document = blocks }),
    focus: vi.fn(),
  }
  editor.replaceBlocks = editor.replaceBlocks.bind(editor) as any
  const onDocumentChange = vi.fn(() => editor.document.map(b => b.content).join('|'))
  const sendMessages = vi.fn(async () => streams.shift()!)
  const ai: any = (AIExtension as any)({
    transport: { sendMessages },
    documentStateBuilder: async () => ({ blocks: [] }),
    onDocumentChange,
  })({ editor })
  const contentOf = (blocks: Block[] | null) => blocks?.map(b => b.content).join('|') ?? null
  return { editor, ai, onDocumentChange, contentOf }
}

describe('AI result is saved only once kept', () => {
  beforeEach(() => { vi.stubGlobal('document', { hidden: true }) })
  afterEach(() => vi.unstubAllGlobals())

  it('saves the starting document during review and publishes the result on accept', async () => {
    const { ai, onDocumentChange, contentOf } = setup([streamOf({ operations: [update('b1', 'ai text')] })])
    expect(ai.reviewBaseline()).toBeNull()

    ai.openAIMenuAtBlock('b1')
    await ai.invokeAI({ userPrompt: 'rewrite' })
    expect(ai.store.state.aiMenuState.status).toBe('user-reviewing')
    expect(contentOf(ai.reviewBaseline())).toBe('original')
    expect(onDocumentChange).not.toHaveBeenCalled()

    ai.acceptChanges()
    expect(onDocumentChange).toHaveBeenCalledOnce()
    expect(onDocumentChange.mock.results[0].value).toBe('ai text')
    expect(ai.reviewBaseline()).toBeNull()
  })

  it('never publishes a rejected or aborted result', async () => {
    const first = setup([streamOf({ operations: [update('b1', 'ai text')] })])
    first.ai.openAIMenuAtBlock('b1')
    await first.ai.invokeAI({ userPrompt: 'rewrite' })
    first.ai.rejectChanges()
    expect(first.onDocumentChange).not.toHaveBeenCalled()
    expect(first.contentOf(first.editor.document)).toBe('original')
    expect(first.ai.reviewBaseline()).toBeNull()

    // A closed tab aborts its page: its result must not be published either.
    const second = setup([streamOf({ operations: [update('b1', 'ai text')] })])
    second.ai.openAIMenuAtBlock('b1')
    await second.ai.invokeAI({ userPrompt: 'rewrite' })
    await second.ai.abort('tab closed')
    expect(second.onDocumentChange).not.toHaveBeenCalled()
  })

  it('keeps the starting document across a retry of a partly applied request', async () => {
    const { ai, onDocumentChange, contentOf, editor } = setup([
      // The first attempt writes b1, then references a block that is gone.
      streamOf({ operations: [update('b1', 'partial'), update('missing', 'x')] }),
      streamOf({ operations: [update('b1', 'complete')] }),
    ])
    ai.openAIMenuAtBlock('b1')
    await ai.invokeAI({ userPrompt: 'rewrite' })
    expect(ai.store.state.aiMenuState.status).toBe('error')
    expect(contentOf(editor.document)).toBe('partial')
    // The partial write is not what gets saved.
    expect(contentOf(ai.reviewBaseline())).toBe('original')

    await ai.retry()
    expect(ai.store.state.aiMenuState.status).toBe('user-reviewing')
    expect(contentOf(ai.reviewBaseline())).toBe('original')
    ai.rejectChanges()
    expect(contentOf(editor.document)).toBe('original')
    expect(onDocumentChange).not.toHaveBeenCalled()
  })

  it('a follow-up prompt keeps the reviewed result and starts from it', async () => {
    const { ai, onDocumentChange, contentOf } = setup([
      streamOf({ operations: [update('b1', 'first')] }),
      streamOf({ operations: [update('b1', 'second')] }),
    ])
    ai.openAIMenuAtBlock('b1')
    await ai.invokeAI({ userPrompt: 'rewrite' })
    await ai.invokeAI({ userPrompt: 'shorter' })

    expect(onDocumentChange).toHaveBeenCalledOnce()
    expect(onDocumentChange.mock.results[0].value).toBe('first')
    expect(contentOf(ai.reviewBaseline())).toBe('first')
  })
})
