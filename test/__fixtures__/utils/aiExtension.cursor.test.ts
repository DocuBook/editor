// @vitest-environment jsdom
import { BlockNoteEditor } from '@blocknote/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSchema } from '../../../frontend/components/editor/setup'
import { AIExtension } from '../../../frontend/utils/aiExtension'

vi.mock('../../../frontend/utils/softKeyboard', () => ({ softKeyboardOnFocus: vi.fn(() => false) }))

/** The agent's caret: labelled "Agent", and once writing is done it stays at
 *  the end of what was written and fades, instead of vanishing at once. */

let editor: BlockNoteEditor<any, any, any> | undefined

beforeEach(() => {
  // A hidden page skips the character reveal, so the write lands in one step.
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  editor?.unmount()
  editor = undefined
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function setup(name?: string) {
  const ai = AIExtension({
    transport: {
      sendMessages: vi.fn(async () => new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'tool-input-available', input: { operations: [{ type: 'update', id: 'b1$', block: '<p>written</p>' }] } })
          controller.close()
        },
      })),
    },
    documentStateBuilder: async () => ({ blocks: [] }),
    ...(name ? { agentCursor: { name, color: 'red' } } : {}),
  } as any)
  editor = BlockNoteEditor.create({
    schema: getSchema() as any,
    initialContent: [{ id: 'b1', type: 'paragraph', content: 'before' }],
    extensions: [ai as any],
  })
  const mount = document.createElement('div')
  document.body.appendChild(mount)
  editor.mount(mount)
  const extension: any = editor.getExtension('ai')
  const caret = () => mount.querySelector<HTMLElement>('.bn-collaboration-cursor__base')
  return { extension, caret }
}

const write = async (extension: any) => {
  extension.openAIMenuAtBlock('b1')
  await extension.invokeAI({ userPrompt: 'rewrite' })
  await vi.waitFor(() => expect(extension.store.state.aiMenuState.status).toBe('user-reviewing'))
}

describe('agent caret', () => {
  it('is labelled Agent unless the editor names it', async () => {
    const { extension, caret } = setup()
    await write(extension)
    expect(caret()?.textContent).toContain('Agent')

    editor!.unmount()
    document.body.innerHTML = ''
    const named = setup('Reviewer')
    await write(named.extension)
    expect(named.caret()?.textContent).toContain('Reviewer')
  })

  it('stays at the end of the write once review starts, fading, then goes', async () => {
    const { extension, caret } = setup()
    await write(extension)

    // Review is up and the caret is still there, now leaving.
    expect(caret()).not.toBeNull()
    expect(caret()!.classList.contains('ai-cursor-leaving')).toBe(true)
    expect(caret()!.getAttribute('data-active')).toBe('true')

    vi.advanceTimersByTime(1_500)
    expect(caret()).not.toBeNull()
    vi.advanceTimersByTime(200)
    expect(caret()).toBeNull()
  })

  it('goes at once when the result is accepted while it lingers', async () => {
    const { extension, caret } = setup()
    await write(extension)
    expect(caret()).not.toBeNull()
    extension.acceptChanges()
    expect(caret()).toBeNull()
    // The pending linger has nothing left to do.
    vi.advanceTimersByTime(2_000)
    expect(caret()).toBeNull()
  })
})
