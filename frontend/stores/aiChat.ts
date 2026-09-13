import { create } from 'zustand'

import { useEditorStore } from './editor'
import { hasTextSelection, openAIMenuAtAnchor } from '../utils/aiBlocks'

interface AiChatState {
  /** True only while xl-ai prompt actions are shown above the composer. */
  expanded: boolean
  input: string
  focusRequest: number
  setExpanded: (v: boolean) => void
  setInput: (v: string) => void
  /** Keyboard shortcut / toolbar prompt consumed by the mounted composer. */
  focusInput: (input?: string) => void
  /** Composer action opens/closes prompt suggestions without touching active AI work. */
  togglePrompts: () => void
}

export const useAiChat = create<AiChatState>((set, get) => ({
  expanded: false,
  input: '',
  focusRequest: 0,
  setExpanded: (v) => set({ expanded: v }),
  setInput: (input) => set({ input }),
  focusInput: (input) => set((state) => ({
    expanded: false,
    input: input === undefined ? state.input : input,
    focusRequest: state.focusRequest + 1,
  })),
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
    // Text-selection prompts live in the formatting toolbar popover; the FAB
    // list is only for cursor/node prompts.
    if (hasTextSelection(editor)) return
    if (menu === 'closed') {
      if (!openAIMenuAtAnchor(editor)) return
    }
    set({ expanded: true })
  },
}))