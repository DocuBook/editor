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
})
