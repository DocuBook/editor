/** Delete the current block — the side menu's drag-handle "Delete", for the
 *  IME toolbar: the side menu is hover-driven, which a touch pointer cannot do,
 *  so a phone had no way to drop a whole block (erasing its text leaves the
 *  block behind). Pinned to the strip's trailing edge (see index.css) so it
 *  stays reachable however far the row is scrolled.
 *
 *  No disabled state, like MoveBlockButtons: with no selection or cursor the
 *  command is a no-op (see utils/deleteBlock). */
import { Trash2 } from 'lucide-react'
import { useBlockNoteEditor, useComponentsContext } from '@blocknote/react'
import { deleteBlockAtCursor } from '../../utils/deleteBlock'

export function DeleteBlockButton() {
  const editor = useBlockNoteEditor<any, any, any>()
  const Components = useComponentsContext()!

  if (!editor.isEditable) return null
  return (
    <Components.FormattingToolbar.Button
      className="bn-button formatting-toolbar-pinned"
      label="Delete block"
      mainTooltip="Delete block"
      icon={<Trash2 size={14} />}
      onClick={() => deleteBlockAtCursor(editor)}
    />
  )
}
