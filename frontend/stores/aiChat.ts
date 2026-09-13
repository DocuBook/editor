import { create } from 'zustand'

import { useEditorStore } from './editor'
import { hasTextSelection, openAIMenuAtAnchor } from '../utils/aiBlocks'

interface AiChatState {
  /** True while text-selection prompts own the AI UI in the formatting toolbar. */
  selectionPromptOpen: boolean
  /** True only while xl-ai prompt actions are shown above the composer. */
  expanded: boolean
  input: string
  focusRequest: number
  setSelectionPromptOpen: (v: boolean) => void
  setExpanded: (v: boolean) => void
  setInput: (v: string) => void
  /** Keyboard shortcut / toolbar prompt consumed by the mounted composer. */
  focusInput: (input?: string) => void
  /** Composer action opens/closes prompt suggestions without touching active AI work. */
  togglePrompts: () => void
}

export const useAiChat = create<AiChatState>((set, get) => ({
  selectionPromptOpen: false,
  expanded: false,
  input: '',
  focusRequest: 0,
  setSelectionPromptOpen: (v) => set({ selectionPromptOpen: v }),
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
    // list is only for cursor/node prompts. Reaching here means the cursor owns
    // the UI, so release any stale selection-prompt ownership.
    if (hasTextSelection(editor)) return
    set({ selectionPromptOpen: false })
    if (menu === 'closed') {
      if (!openAIMenuAtAnchor(editor)) return
    }
    set({ expanded: true })
  },
}))