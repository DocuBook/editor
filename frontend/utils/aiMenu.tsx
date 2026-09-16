import type { ReactElement } from 'react'
import { ArrowDownAZ, Check, Languages, ListEnd, ListTodo, PenLine, RefreshCw, Sparkles, Trash2, WandSparkles } from 'lucide-react'

export type AiMenuStatus = 'user-input' | 'thinking' | 'ai-writing' | 'user-reviewing' | 'error' | 'closed'
/** Mirrors BlockNote's `DefaultReactSuggestionItem`:
 *  `icon` is a rendered element (not a component) because the formatting-toolbar
 *  popover passes the item straight to `SuggestionMenu.Item`, which renders
 *  `{item.icon}` as a child. Passing a component object there crashes React with
 *  "Objects are not valid as a React child". */
export type AiMenuItem = {
  key: string
  title: string
  icon: ReactElement
  size?: 'small'
  onItemClick: (setPrompt: (prompt: string) => void) => void | Promise<void>
}

const invoke = (editor: any, options: any) => editor?.getExtension?.('ai')?.invokeAI(options)

/** Prompt strings are rust-ai's exact `userPrompt` values (lowercase), while the
 *  chip titles are title case — the two differ on purpose. */
export function getDefaultAIMenuItems(editor: any, status: AiMenuStatus): AiMenuItem[] {
  if (status === 'user-reviewing') return [
    { key: 'accept', title: 'Accept', icon: <Check size={18} />, size: 'small', onItemClick: () => editor?.getExtension?.('ai')?.acceptChanges() },
    { key: 'revert', title: 'Revert', icon: <RefreshCw size={18} />, size: 'small', onItemClick: () => editor?.getExtension?.('ai')?.rejectChanges() },
  ]
  if (status === 'error') return [
    { key: 'retry', title: 'Retry', icon: <RefreshCw size={18} />, size: 'small', onItemClick: () => editor?.getExtension?.('ai')?.retry() },
    { key: 'cancel', title: 'Cancel', icon: <Trash2 size={18} />, size: 'small', onItemClick: () => editor?.getExtension?.('ai')?.rejectChanges() },
  ]
  if (status !== 'user-input') return []
  const selected = !!editor?.getSelection?.()?.blocks?.length
  if (selected) return [
    { key: 'improve_writing', title: 'Improve Writing', icon: <WandSparkles size={18} />, size: 'small', onItemClick: () => invoke(editor, { useSelection: true, userPrompt: 'Improve writing' }) },
    { key: 'fix_spelling', title: 'Fix Spelling', icon: <Check size={18} />, size: 'small', onItemClick: () => invoke(editor, { useSelection: true, userPrompt: 'Fix spelling' }) },
    { key: 'translate', title: 'Translate…', icon: <Languages size={18} />, size: 'small', onItemClick: (setPrompt) => setPrompt('Translate into ') },
    { key: 'simplify', title: 'Simplify', icon: <Sparkles size={18} />, size: 'small', onItemClick: () => invoke(editor, { useSelection: true, userPrompt: 'Simplify' }) },
  ]
  return [
    { key: 'continue_writing', title: 'Continue Writing', icon: <ArrowDownAZ size={18} />, size: 'small', onItemClick: () => invoke(editor, { userPrompt: 'Continue writing at the current cursor position related to the previous text. Add multiple blocks if needed. If the document looks like a template / draft, follow the template. Be extensive if needed.' }) },
    { key: 'summarize', title: 'Summarize', icon: <ListEnd size={18} />, size: 'small', onItemClick: () => invoke(editor, { userPrompt: 'Summarize' }) },
    { key: 'action_items', title: 'Add Action Items', icon: <ListTodo size={18} />, size: 'small', onItemClick: () => invoke(editor, { userPrompt: 'Add action items' }) },
    { key: 'write_anything', title: 'Write Anything…', icon: <PenLine size={18} />, size: 'small', onItemClick: (setPrompt) => setPrompt('Write about ') },
  ]
}

export function getAIDictionary() {
  return { formatting_toolbar: { ai: { tooltip: 'Edit with AI' } } }
}
