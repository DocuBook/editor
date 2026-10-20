import { ChevronLeft, ChevronRight, CodeXml } from 'lucide-react'
import type { ReactNode } from 'react'
import { RiFinderLine } from 'react-icons/ri'
import { SiZedindustries } from 'react-icons/si'
import { VscVscode } from 'react-icons/vsc'
import type { EditMode } from '../../stores/editor'
import { ModeSwitchIcon } from './editorActions'

/** One editor detected by the backend (folder-capable app, not a hardcoded
 *  list). `path` is the app bundle the open command targets. */
export interface EditorApp { name: string; path: string }

export interface EditorAction {
  key: string
  label: string
  icon: ReactNode
  onSelect: () => void
  disabled?: boolean
  title?: string
  /** Draw a separator above this row, grouping editing from file actions. */
  divider?: boolean
}

interface EditorActionOptions {
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  /** Compact (<640px) moves history into the menu; wide keeps it inline. */
  includeHistory: boolean
  editMode: EditMode
  toggleable: boolean
  hasFile: boolean
  fileDeleted: boolean
  editors: EditorApp[]
  onToggleMode: () => void
  /** Omitted on the web runtime — external editor actions are desktop-only. */
  onOpenInEditor?: (app?: string) => void
  onRevealInFinder?: () => void
  revealLabel: string
}

/** Brand icon per detected editor. Matching is by the LaunchServices display
 *  name, so it stays tolerant of case and separators — and it only picks an
 *  icon: the row itself is offered for whatever the backend detected. */
function editorIcon(name: string): ReactNode {
  const n = name.toLowerCase()
  if (n.includes('zed')) return <SiZedindustries size={14} />
  if (n.includes('visual studio code') || n.includes('vscode')) return <VscVscode size={14} />
  return <CodeXml size={14} />
}

/** One ordered action list for every Actions trigger (icon on desktop, compact
 *  text on mobile). Keeping the mode handler here means the label, icon and
 *  disabled rule are defined once instead of per trigger. */
export function buildEditorActions({
  canUndo, canRedo, onUndo, onRedo, includeHistory,
  editMode, toggleable, hasFile, fileDeleted, editors,
  onToggleMode, onOpenInEditor, onRevealInFinder, revealLabel,
}: EditorActionOptions): EditorAction[] {
  const modeLabel = !hasFile
    ? 'No file to switch'
    : toggleable
      ? 'Switch to ' + (editMode === 'editor' ? 'markdown' : 'editor')
      : 'Preview only'
  const actions: EditorAction[] = []
  if (includeHistory) {
    actions.push(
      { key: 'undo', label: 'Undo', icon: <ChevronLeft size={14} />, onSelect: onUndo, disabled: !canUndo },
      { key: 'redo', label: 'Redo', icon: <ChevronRight size={14} />, onSelect: onRedo, disabled: !canRedo },
    )
  }
  actions.push({
    key: 'mode',
    label: modeLabel,
    icon: <ModeSwitchIcon editMode={editMode} size={14} />,
    onSelect: onToggleMode,
    disabled: !toggleable,
  })
  if (onOpenInEditor) {
    if (editors.length > 0) {
      editors.forEach((editor, index) => actions.push({
        key: 'editor:' + editor.path,
        label: 'Open in ' + editor.name,
        icon: editorIcon(editor.name),
        onSelect: () => onOpenInEditor(editor.path),
        disabled: !hasFile || fileDeleted,
        divider: actions.length > 0 && index === 0,
      }))
    } else {
      actions.push({
        key: 'open-in-editor',
        label: 'Open in editor',
        icon: <CodeXml size={14} />,
        onSelect: () => onOpenInEditor(),
        disabled: !hasFile || fileDeleted,
        divider: true,
      })
    }
  }
  if (onRevealInFinder) {
    actions.push({
      key: 'reveal-in-finder',
      label: revealLabel,
      icon: <RiFinderLine size={14} />,
      onSelect: onRevealInFinder,
      disabled: !hasFile || fileDeleted,
    })
  }
  return actions
}
