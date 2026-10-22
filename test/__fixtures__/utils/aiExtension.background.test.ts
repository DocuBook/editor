import { afterEach, describe, expect, it, vi } from 'vitest'
import { AIExtension } from '../../../frontend/utils/aiExtension'

afterEach(() => vi.unstubAllGlobals())

describe('AI extension page lifecycle', () => {
  it('keeps the stream alive while detached and applies its result when the page reattaches', async () => {
    vi.stubGlobal('document', { hidden: true })
    let view: any = null
    const detachedView = new Proxy({ state: { doc: { content: { size: 10 }, descendants: () => {} } } }, {
      get(target, key) {
        if (key in target) return (target as any)[key]
        throw new Error(`detached view access: ${String(key)}`)
      },
    })
    const input = { operations: [{ type: 'update', id: 'block-1', block: '<p>updated</p>' }] }
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'tool-input-available', input })
        controller.close()
      },
    })
    const sendMessages = vi.fn(async (request: any) => {
      expect(request.abortSignal.aborted).toBe(false)
      return stream
    })
    const editor = {
      document: [{ id: 'block-1', type: 'paragraph', content: 'before' }],
      headless: true,
      get prosemirrorView() { return view ?? detachedView },
      getBlock: (id: string) => id === 'block-1' ? { id } : undefined,
      getSelection: () => undefined,
      getExtension: () => undefined,
      tryParseHTMLToBlocks: () => [{ type: 'paragraph', content: 'updated' }],
      transact: (callback: () => void) => callback(),
      updateBlock: vi.fn(),
      focus: vi.fn(),
    }
    const onDocumentChange = vi.fn()
    const ai: any = (AIExtension as any)({
      transport: { sendMessages },
      documentStateBuilder: async () => ({ blocks: [] }),
      onDocumentChange,
    })({ editor })

    ai.openAIMenuAtBlock('block-1')
    await ai.invokeAI({ userPrompt: 'update this page' })

    expect(sendMessages).toHaveBeenCalledOnce()
    expect(editor.updateBlock).not.toHaveBeenCalled()
    expect(ai.store.state.aiMenuState.status).toBe('ai-writing')

    editor.headless = false
    view = {
      isDestroyed: false,
      state: { doc: { content: { size: 10 }, descendants: () => {} } },
      dispatch: vi.fn(),
    }
    ai.attach()

    expect(editor.updateBlock).toHaveBeenCalledOnce()
    expect(onDocumentChange).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(ai.store.state.aiMenuState.status).toBe('user-reviewing'))
  })
})
