import { describe, expect, it, vi } from 'vitest'

import { AIExtension } from '../../../frontend/utils/aiExtension'

/** Minimal BlockNote editor stand-in: the retry path only touches the document
 *  snapshot and the showSelection extension before the transport call. */
function makeEditor() {
  return {
    document: [],
    isEditable: true,
    getExtension: vi.fn(() => undefined),
    focus: vi.fn(),
    replaceBlocks: vi.fn(),
    getSelection: vi.fn(() => undefined),
  }
}

describe('AI extension retry', () => {
  it('re-sends the original prompt so the model has a task to retry', async () => {
    const editor = makeEditor()
    const sent: any[] = []
    const transport = {
      sendMessages: vi.fn(async (request: any) => {
        sent.push(request)
        throw new Error('provider unavailable')
      }),
    }
    const ai: any = (AIExtension as any)({
      transport,
      documentStateBuilder: async () => ({ blocks: [] }),
    })({ editor })

    // A failed turn leaves the menu in `error` and keeps the session alive.
    ai.openAIMenuAtBlock('b1')
    await ai.invokeAI({ userPrompt: 'Summarize this note' })
    expect(ai.store.state.aiMenuState.status).toBe('error')

    await ai.retry()

    expect(sent).toHaveLength(2)
    // Regression: the retry used to send an error notice instead of the prompt,
    // so the model replied "no last prompt content… cannot retry".
    expect(sent[1].messages[0].parts[0].text).toBe('Summarize this note')
  })

  it('stops after the retry budget instead of issuing unlimited requests', async () => {
    const editor = makeEditor()
    const transport = { sendMessages: vi.fn(async () => { throw new Error('provider unavailable') }) }
    const ai: any = (AIExtension as any)({
      transport,
      documentStateBuilder: async () => ({ blocks: [] }),
    })({ editor })

    ai.openAIMenuAtBlock('b1')
    await ai.invokeAI({ userPrompt: 'do the thing' })
    // The error surface carries the remaining budget for the UI to disable Retry.
    expect(ai.store.state.aiMenuState.retriesLeft).toBe(3)

    for (let i = 0; i < 3; i++) await ai.retry()
    // Budget spent: the click must be a no-op, not a fourth provider call.
    await ai.retry()

    expect(transport.sendMessages).toHaveBeenCalledTimes(4)
    expect(ai.store.state.aiMenuState.retriesLeft).toBe(0)
  })

  it('resets the budget for a fresh prompt', async () => {
    const editor = makeEditor()
    const transport = { sendMessages: vi.fn(async () => { throw new Error('provider unavailable') }) }
    const ai: any = (AIExtension as any)({
      transport,
      documentStateBuilder: async () => ({ blocks: [] }),
    })({ editor })

    ai.openAIMenuAtBlock('b1')
    await ai.invokeAI({ userPrompt: 'first attempt' })
    await ai.retry()
    expect(ai.store.state.aiMenuState.retriesLeft).toBe(2)

    // A new prompt is a new budget — the bound is per turn, not per session.
    await ai.invokeAI({ userPrompt: 'a different prompt' })
    expect(ai.store.state.aiMenuState.retriesLeft).toBe(3)
  })
})
