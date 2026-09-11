import { create } from 'zustand'

import { useEditorStore } from './editor'

interface AiChatState {
  /** True only while xl-ai prompt actions are shown above the composer. */
  expanded: boolean
  focusRequest: number
  setExpanded: (v: boolean) => void
  /** Keyboard shortcut request consumed by the mounted composer. */
  focusInput: () => void
  /** Composer action opens/closes prompt suggestions without touching active AI work. */
  togglePrompts: () => void
}

export const useAiChat = create<AiChatState>((set, get) => ({
  expanded: false,
  focusRequest: 0,
  setExpanded: (v) => set({ expanded: v }),
  focusInput: () => set((state) => ({ expanded: false, focusRequest: state.focusRequest + 1 })),
  togglePrompts: () => {
    const editor = useEditorStore.getState().blockEditor
    const ai = editor?.getExtension?.('ai')
    if (!ai) return
    const menu = ai.store.state.aiMenuState

    if (get().expanded) {
      if (menu !== 'closed' && menu.status === 'user-input') ai.closeAIMenu()
      set({ expanded: false })
      return
    }
    if (menu !== 'closed' && menu.status !== 'user-input') return
    if (menu === 'closed') {
      const blockId = editor.getTextCursorPosition?.()?.block?.id
      if (!blockId) return
      ai.openAIMenuAtBlock(blockId)
    }
    set({ expanded: true })
  },
}))