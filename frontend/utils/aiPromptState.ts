import { frameReference } from './aiGrounding'

export function injectMentionContextMessages(messages: any[], context: any): any[] {
  if (!context || (!context.files?.length && !context.skipped?.length)) return messages
  const files = (context.files || []).map((file: any) => `<file path="${String(file.path).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}" truncated="${file.truncated ? 'true' : 'false'}">\n${file.content}\n</file>`).join('\n')
  const skipped = (context.skipped || []).map((item: any) => `${item.path}: ${item.reason}`).join('\n')
  const block = frameReference('vault content', 'vault_context', `${files}${skipped ? `\n<skipped>\n${skipped}\n</skipped>` : ''}`)
  const latest = [...messages].map((message, index) => ({ message, index })).reverse().find(({ message }) => message?.role === 'user')?.index ?? -1
  const injected = { role: 'assistant', id: `assistant-vault-context-${latest >= 0 ? messages[latest]?.id || 'latest' : 'latest'}`, parts: [{ type: 'text', text: block }] }
  return latest < 0 ? [...messages, injected] : [...messages.slice(0, latest), injected, ...messages.slice(latest)]
}

/** One context-tool result gathered in tool mode, kept as plain reference data. */
export interface ReferenceResult {
  tool: string
  input: string
  content: string
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Text-mode (Path B) form of web results gathered before a fallback. Path B
 *  edits through Markdown only, so it never sees tool calls: the results reach
 *  it as untrusted reference data, framed by the same helper as the vault
 *  context. A closing tag
 *  inside the content is neutralised so a page cannot end the block early. */
export function formatWebReferences(references: readonly ReferenceResult[]): string {
  if (!references.length) return ''
  const results = references
    .map(reference => `<result tool="${escapeAttribute(reference.tool)}" input="${escapeAttribute(reference.input)}">\n${reference.content.replace(/<\/(result|web_context)/gi, '&lt;/$1')}\n</result>`)
    .join('\n')
  return frameReference('web content', 'web_context', results)
}

export function injectDocumentStateMessages(messages: any[]): any[] {
  return messages.flatMap((message) => {
    const state = message?.role === 'user' ? message?.metadata?.documentState : undefined
    if (!state) return [message]
    const context = state.selection
      ? [
          'This is the latest state of the selection (ignore previous selections, you MUST issue operations against this latest version of the selection). Each block is listed with its own content only; a nested block is listed separately, after its parent, with depth: how many levels it is nested. Deleting a block also deletes the blocks nested under it:',
          JSON.stringify(state.selectedBlocks || []),
          'These are the blocks just before and after the selection, for context only (the selected blocks are not repeated here). You MUST NOT issue operations against them; you MUST issue operations against the selection:',
          JSON.stringify(state.blocks || []),
        ]
      : [
          `There is no active selection. This is the latest state of the document (ignore previous documents, you MUST issue operations against this latest version of the document). The user's caret is in the block marked caret: true. Each block is listed with its own content only; a nested block is listed separately, after its parent, with depth: how many levels it is nested. Deleting a block also deletes the blocks nested under it.\n${state.isEmptyDocument ? 'Because the document is empty, YOU MUST first update the empty block before adding new blocks.' : `${state.caretBlockEmpty ? 'The caret block is empty: to write at the caret, YOU MUST update that block first, then add any further blocks after it. ' : ''}Prefer updating existing blocks over removing and adding (but this also depends on the user\'s question).`}`,
          JSON.stringify(state.blocks || []),
        ]
    return [
      { role: 'assistant', id: `assistant-document-state-${message.id || 'latest'}`, parts: context.map((text) => ({ type: 'text', text })) },
      message,
    ]
  })
}
