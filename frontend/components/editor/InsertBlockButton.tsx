/** Formatting-toolbar "insert paragraph" — the side menu's `+`, for the shells
 *  that have no side menu: every width below the 640px breakpoint, where
 *  WysiwygEditor keys BOTH to the same `isDesktop` query (the side menu is
 *  hover-driven, which a touch pointer cannot do at any width).
 *
 *  Inserts directly; the slash menu is not opened here (see utils/insertBlock
 *  for why). Reordering is the companion MoveBlockButtons, not a drag handle:
 *  dragging is HTML5 drag-and-drop, which touch does not fire. */
import { Plus } from 'lucide-react'
import { useBlockNoteEditor, useComponentsContext } from '@blocknote/react'
import { insertBlockAtCursor } from '../../utils/insertBlock'

export function InsertBlockButton() {
  const editor = useBlockNoteEditor<any, any, any>()
  const Components = useComponentsContext()!

  /** No insert affordance while the document is read-only. */
  if (!editor.isEditable) return null
  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      label="Insert paragraph"
      mainTooltip="Insert paragraph"
      icon={<Plus size={14} />}
      onClick={() => insertBlockAtCursor(editor)}
    />
  )
}
