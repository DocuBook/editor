import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIExtension } from '../../../frontend/utils/aiExtension'

/** The menu label follows the transport's phase parts: a request that looks up
 *  context or re-asks after it began generating goes back to `thinking`, with
 *  the reason, instead of claiming to generate through the whole wait. */

function setup() {
  let push: (part: any) => void = () => {}
  let end: () => void = () => {}
  const stream = new ReadableStream({
    start(controller) {
      push = part => controller.enqueue(part)
      end = () => controller.close()
    },
  })
  const editor = {
    document: [{ id: 'b1', type: 'paragraph', content: 'original' }],
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
    replaceBlocks(_ids: string[], blocks: any[]) { this.document = blocks },
    focus: vi.fn(),
  }
  const ai: any = (AIExtension as any)({
    transport: { sendMessages: vi.fn(async () => stream) },
    documentStateBuilder: async () => ({ blocks: [] }),
  })({ editor })
  const menu = () => ai.store.state.aiMenuState
  /** Let the reader loop take the part just pushed. */
  const step = async (part: any) => {
    push(part)
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  return { ai, menu, step, end }
}

describe('AI menu phase', () => {
  beforeEach(() => { vi.stubGlobal('document', { hidden: true }) })
  afterEach(() => vi.unstubAllGlobals())

  it('follows the phase parts back to thinking after generating began', async () => {
    const { ai, menu, step, end } = setup()
    ai.openAIMenuAtBlock('b1')
    const running = ai.invokeAI({ userPrompt: 'rewrite' })
    await vi.waitFor(() => expect(menu().status).toBe('thinking'))

    await step({ type: 'phase', phase: 'reasoning' })
    expect(menu()).toMatchObject({ status: 'thinking', phase: 'reasoning' })

    await step({ type: 'writing-started' })
    expect(menu().status).toBe('generating')
    expect(menu().phase).toBeUndefined()

    await step({ type: 'phase', phase: 'researching' })
    expect(menu()).toMatchObject({ status: 'thinking', phase: 'researching' })

    await step({ type: 'phase', phase: 'retrying' })
    expect(menu()).toMatchObject({ status: 'thinking', phase: 'retrying' })

    // An unknown phase is not a label the menu can show.
    await step({ type: 'phase', phase: 'bogus' })
    expect(menu().phase).toBe('retrying')

    await step({ type: 'tool-input-available', input: { operations: [{ type: 'update', id: 'b1', block: '<p>new</p>' }] } })
    end()
    await running
    expect(menu().status).toBe('user-reviewing')
  })
})
