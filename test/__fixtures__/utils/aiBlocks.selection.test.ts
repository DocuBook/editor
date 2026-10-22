// @vitest-environment jsdom
import { BlockNoteEditor } from '@blocknote/core'
import { TextSelection } from 'prosemirror-state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSchema } from '../../../frontend/components/editor/setup'
import { captureAISelection } from '../../../frontend/utils/aiBlocks'
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

describe('AI text selection operations', () => {
  it('sends and replaces only the selected text, preserving the rest of its block', async () => {
    editor = BlockNoteEditor.create({
      schema: getSchema() as any,
      initialContent: [{ id: 'paragraph', type: 'paragraph', content: 'before selected after' }],
    })
    const mount = document.createElement('div')
    document.body.appendChild(mount)
    editor.mount(mount)

    let paragraphPos = -1
    editor.prosemirrorView!.state.doc.descendants((node, pos) => {
      if (node.type.name === 'paragraph') paragraphPos = pos
    })
    const from = paragraphPos + 1 + 'before '.length
    const to = from + 'selected'.length
    editor.transact((tr) => tr.setSelection(TextSelection.create(tr.doc, from, to)))
    expect(captureAISelection(editor)).toBe(true)

    let selectedBlocks: any[] = []
    const transport = {
      sendMessages: vi.fn(() => new ReadableStream({
        start(controller) {
          controller.enqueue({
            type: 'tool-input-available',
            input: {
              operations: [{ type: 'update', id: 'paragraph$', block: '<p>improved</p>' }],
            },
          })
          controller.close()
        },
      })),
    }
    const ai: any = (AIExtension as any)({
      transport,
      documentStateBuilder: async ({ selectedBlocks: blocks }: any) => {
        selectedBlocks = blocks
        return { selection: true, selectedBlocks: [] }
      },
    })({ editor })

    ai.openAIMenuAtBlock('paragraph')
    await ai.invokeAI({ userPrompt: 'Improve Writing', useSelection: true })

    expect(selectedBlocks).toHaveLength(1)
    expect(await editor.blocksToHTMLLossy(selectedBlocks)).toContain('selected')
    expect(await editor.blocksToHTMLLossy(selectedBlocks)).not.toContain('before')
    expect(await editor.blocksToHTMLLossy(selectedBlocks)).not.toContain('after')
    expect(await editor.blocksToMarkdownLossy(editor.document)).toContain('before improved after')
  })
})
