import { create } from 'zustand'
import { AIExtension } from '@blocknote/xl-ai'
import { useEditorStore } from './editor'

interface AiChatState {
  /** True while the chat panel is shown (as opposed to the collapsed FAB). */
  expanded: boolean
  setExpanded: (v: boolean) => void
  /** ⌃⌥L / FAB: close an open menu (abort if streaming, reject if reviewing),
   *  otherwise open the AI menu at the cursor block and show the panel. */
  toggle: () => void
}

export const useAiChat = create<AiChatState>((set) => ({
  expanded: false,
  setExpanded: (v) => set({ expanded: v }),
  toggle: () => {
    const editor = useEditorStore.getState().blockEditor
    if (!editor) return
    const ai = editor.getExtension?.(AIExtension)
    if (!ai) return
    const menu = ai.store.state.aiMenuState
    if (menu && menu !== 'closed') {
      if (menu.status === 'thinking' || menu.status === 'ai-writing') {
        ai.abort?.('dismissed by user').catch(() => {})
      } else if (menu.status === 'user-reviewing' || menu.status === 'error') {
        ai.rejectChanges()
      } else {
        ai.closeAIMenu()
      }
      set({ expanded: false })
    } else {
      const pos = editor.getTextCursorPosition?.()
      if (pos?.block?.id) ai.openAIMenuAtBlock(pos.block.id)
      set({ expanded: true })
    }
  },
}))