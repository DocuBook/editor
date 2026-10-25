// @vitest-environment jsdom
import { BlockNoteEditor } from '@blocknote/core'
import { TextSelection } from 'prosemirror-state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSchema } from '../../../frontend/components/editor/setup'
import { captureAISelection, getAISelectionSnapshot, hasAISelection, openAIMenuAtAnchor, restoreAISelection } from '../../../frontend/utils/aiBlocks'
import { AIExtension } from '../../../frontend/utils/aiExtension'

vi.mock('../../../frontend/utils/softKeyboard', () => ({
  softKeyboardOnFocus: vi.fn(() => false),
}))

let editor: BlockNoteEditor<any, any, any> | undefined

afterEach(() => {
  editor?.unmount()
  editor = undefined
  document.body.innerHTML = ''
})

function mountEditor() {
  editor = BlockNoteEditor.create({
    schema: getSchema() as any,
    initialContent: [
      { id: 'a', type: 'paragraph', content: 'alpha beta gamma' },
      { id: 'b', type: 'paragraph', content: 'second paragraph' },
    ],
  })
  const mount = document.createElement('div')
  document.body.appendChild(mount)
  editor.mount(mount)
  return editor as any
}

function textPos(ed: any, blockId: string, text: string) {
  let blockPos = -1
  ed.prosemirrorView.state.doc.descendants((node: any, pos: number) => {
    if (node.attrs?.id !== blockId) return true
    blockPos = pos
    return false
  })
  return blockPos + 2 + ed.prosemirrorView.state.doc.nodeAt(blockPos).firstChild.textContent.indexOf(text)
}

function selectText(ed: any, blockId: string, text: string) {
  const start = textPos(ed, blockId, text)
  ed.transact((tr: any) => tr.setSelection(TextSelection.create(tr.doc, start, start + text.length)))
}

/** From `text` in one block through `text` in a later one: a multi-block range. */
function selectAcross(ed: any, from: [string, string], to: [string, string]) {
  const start = textPos(ed, from[0], from[1])
  const end = textPos(ed, to[0], to[1]) + to[1].length
  ed.transact((tr: any) => tr.setSelection(TextSelection.create(tr.doc, start, end)))
}

/** Each provider call stays pending until the test answers it, so requests can
 *  overlap the way a slow model makes them overlap. */
function deferredTransport() {
  const calls: any[] = []
  const answers: Array<(input: any) => void> = []
  return {
    calls,
    answer(index: number, operations: any[]) {
      answers[index]({ operations })
    },
    transport: {
      sendMessages: vi.fn((request: any) => {
        calls.push(request)
        return new Promise((resolve) => {
          answers.push((input) => resolve(new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'tool-input-available', input })
              controller.close()
            },
          })))
        })
      }),
    },
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await tick()
  expect(check()).toBe(true)
}

/** The extension as the editor would register it: openAIMenuAtAnchor looks it
 *  up through editor.getExtension('ai'). */
function attachAi(ed: any, transport: any) {
  const ai: any = (AIExtension as any)({
    transport,
    documentStateBuilder: async ({ selectedBlocks }: any) => ({ selection: selectedBlocks.length > 0 }),
  })({ editor: ed })
  const getExtension = ed.getExtension.bind(ed)
  ed.getExtension = (name: string) => (name === 'ai' ? ai : getExtension(name))
  return ai
}

/** The composer's submit (AiFloatingChat): no re-anchor while the menu is open,
 *  selection mode whenever a selection is remembered. */
function submitFromComposer(ed: any, ai: any, prompt: string) {
  if (ai.store.state.aiMenuState === 'closed' && !openAIMenuAtAnchor(ed)) return 'no-anchor'
  const useSelection = hasAISelection(ed)
  if (useSelection && !restoreAISelection(ed)) {
    ai.closeAIMenu()
    return 'selection-unavailable'
  }
  void ai.invokeAI({ userPrompt: prompt, useSelection })
  return useSelection ? 'selection' : 'cursor'
}

const markdown = async (ed: any) => (await ed.blocksToMarkdownLossy(ed.document)).trim()

describe('AI session hand-off between prompts', () => {
  it('runs a follow-up typed during a selection review instead of failing on the spent selection', async () => {
    const ed = mountEditor()
    const provider = deferredTransport()
    const ai = attachAi(ed, provider.transport)

    selectText(ed, 'a', 'beta')
    captureAISelection(ed)
    openAIMenuAtAnchor(ed)
    const first = ai.invokeAI({ userPrompt: 'Improve writing', useSelection: true })
    await until(() => provider.calls.length === 1)
    provider.answer(0, [{ type: 'update', id: 'a$', block: '<p>BETA</p>' }])
    await first
    expect(ai.store.state.aiMenuState.status).toBe('user-reviewing')
    // The written range is gone, so nothing may still claim to be "the selection".
    expect(getAISelectionSnapshot(ed)).toBeUndefined()
    expect(hasAISelection(ed)).toBe(false)

    // Regression: the stale snapshot forced this prompt into selection mode,
    // where it failed ("Text selection is no longer available"), closed the
    // review and dropped the prompt.
    expect(submitFromComposer(ed, ai, 'Write about cats')).toBe('cursor')
    await until(() => provider.calls.length === 2)
    expect(provider.calls[1].messages[0].parts[0].text).toBe('Write about cats')
    expect(provider.calls[1].messages[0].metadata.documentState).toEqual({ selection: false })
    expect(ai.store.state.aiMenuState).toMatchObject({ blockId: 'a' })

    provider.answer(1, [{ type: 'update', id: 'b$', block: '<p>cats</p>' }])
    await until(() => ai.store.state.aiMenuState.status === 'user-reviewing')
    expect(await markdown(ed)).toBe('alpha BETA gamma\n\ncats')

    // Like any follow-up, Revert undoes this turn on top of the previous result.
    ai.rejectChanges()
    expect(await markdown(ed)).toBe('alpha BETA gamma\n\nsecond paragraph')
  })

  /** Regression: only the single-block inline replace collapsed the live range.
   *  Multi-block `updateBlock` and `add` ops map it through the change and
   *  leave it non-empty, so `hasAISelection` still reported "the selection"
   *  and the follow-up silently rewrote the reviewed blocks. */
  it.each<[string, any[], string]>([
    ['two update ops', [
      { type: 'update', id: 'a$', block: '<p>ALPHA BETA GAMMA</p>' },
      { type: 'update', id: 'b$', block: '<p>SECOND</p>' },
    ], 'ALPHA BETA GAMMA\n\nSECOND'],
    ['an update and an add op', [
      { type: 'update', id: 'a$', block: '<p>ALPHA BETA GAMMA</p>' },
      { type: 'add', referenceId: 'b$', position: 'after', blocks: ['<p>added</p>'] },
    ], 'ALPHA BETA GAMMA\n\nsecond paragraph\n\nadded'],
  ])('runs a follow-up in cursor mode after a multi-block selection result applied with %s', async (_label, operations, result) => {
    const ed = mountEditor()
    const provider = deferredTransport()
    const ai = attachAi(ed, provider.transport)

    selectAcross(ed, ['a', 'beta'], ['b', 'paragraph'])
    expect(ed.getSelection().blocks.map((block: any) => block.id)).toEqual(['a', 'b'])
    captureAISelection(ed)
    openAIMenuAtAnchor(ed)
    const first = ai.invokeAI({ userPrompt: 'Improve writing', useSelection: true })
    await until(() => provider.calls.length === 1)
    provider.answer(0, operations)
    await first
    expect(ai.store.state.aiMenuState.status).toBe('user-reviewing')
    expect(await markdown(ed)).toBe(result)
    // The live range is collapsed, not just the snapshot dropped.
    expect(ed.prosemirrorView.state.selection.empty).toBe(true)
    expect(hasAISelection(ed)).toBe(false)

    expect(submitFromComposer(ed, ai, 'Add an introduction')).toBe('cursor')
    await until(() => provider.calls.length === 2)
    expect(provider.calls[1].messages[0].metadata.documentState).toEqual({ selection: false })

    provider.answer(1, [{ type: 'add', referenceId: 'a$', position: 'before', blocks: ['<p>intro</p>'] }])
    await until(() => ai.store.state.aiMenuState.status === 'user-reviewing')
    expect(await markdown(ed)).toBe(`intro\n\n${result}`)

    // The reviewed blocks were never re-targeted: Revert leaves the first result.
    ai.rejectChanges()
    expect(await markdown(ed)).toBe(result)
  })

  it('keeps the selection when the result could not be applied, so Retry still targets it', async () => {
    const ed = mountEditor()
    const provider = deferredTransport()
    const ai = attachAi(ed, provider.transport)

    selectText(ed, 'a', 'beta')
    captureAISelection(ed)
    openAIMenuAtAnchor(ed)
    const first = ai.invokeAI({ userPrompt: 'Fix spelling', useSelection: true })
    await until(() => provider.calls.length === 1)
    provider.answer(0, [{ type: 'update', id: 'missing$', block: '<p>x</p>' }])
    await first

    expect(ai.store.state.aiMenuState.status).toBe('error')
    expect(getAISelectionSnapshot(ed)?.map((block: any) => block.id)).toEqual(['a'])
  })

  it('ignores a superseded request that answers after the newer one', async () => {
    const ed = mountEditor()
    const provider = deferredTransport()
    const ai = attachAi(ed, provider.transport)

    openAIMenuAtAnchor(ed)
    const stale = ai.invokeAI({ userPrompt: 'first' })
    await until(() => provider.calls.length === 1)
    const fresh = ai.invokeAI({ userPrompt: 'second' })
    await until(() => provider.calls.length === 2)
    // The older request is cancelled when the newer one takes over.
    expect(provider.calls[0].abortSignal.aborted).toBe(true)

    provider.answer(1, [{ type: 'update', id: 'b$', block: '<p>from second</p>' }])
    await fresh
    expect(ai.store.state.aiMenuState.status).toBe('user-reviewing')

    provider.answer(0, [{ type: 'update', id: 'a$', block: '<p>from first</p>' }])
    await stale
    expect(await markdown(ed)).toBe('alpha beta gamma\n\nfrom second')
    expect(ai.store.state.aiMenuState.status).toBe('user-reviewing')
  })

  it('does not write a late answer into the document after the menu is closed', async () => {
    const ed = mountEditor()
    const provider = deferredTransport()
    const ai = attachAi(ed, provider.transport)

    openAIMenuAtAnchor(ed)
    const pending = ai.invokeAI({ userPrompt: 'Summarize' })
    await until(() => provider.calls.length === 1)
    ai.closeAIMenu()

    provider.answer(0, [{ type: 'update', id: 'a$', block: '<p>late</p>' }])
    await pending
    expect(await markdown(ed)).toBe('alpha beta gamma\n\nsecond paragraph')
    expect(ai.store.state.aiMenuState).toBe('closed')
  })
})
