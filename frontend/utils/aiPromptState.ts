export function injectDocumentStateMessages(messages: any[]): any[] {
  return messages.flatMap((message) => {
    const state = message?.role === 'user' ? message?.metadata?.documentState : undefined
    if (!state) return [message]
    const context = state.selection
      ? [
          'This is the latest state of the selection (ignore previous selections, you MUST issue operations against this latest version of the selection):',
          JSON.stringify(state.selectedBlocks || []),
          'This is the latest state of the entire document (INCLUDING the selected text), you can use this to find the selected text to understand the context (but you MUST NOT issue operations against this document, you MUST issue operations against the selection):',
          JSON.stringify(state.blocks || []),
        ]
      : [
          `There is no active selection. This is the latest state of the document (ignore previous documents, you MUST issue operations against this latest version of the document). The cursor is BETWEEN two blocks as indicated by cursor: true.\n${state.isEmptyDocument ? 'Because the document is empty, YOU MUST first update the empty block before adding new blocks.' : 'Prefer updating existing blocks over removing and adding (but this also depends on the user\'s question).'}`,
          JSON.stringify(state.blocks || []),
        ]
    return [
      { role: 'assistant', id: `assistant-document-state-${message.id || 'latest'}`, parts: context.map((text) => ({ type: 'text', text })) },
      message,
    ]
  })
}
