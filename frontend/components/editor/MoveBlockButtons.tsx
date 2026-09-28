/** Move the current block up/down — companion of InsertBlockButton for the
 *  shells that have no side menu. The drag handle itself is not reused: dragging
 *  is HTML5 drag-and-drop, which touch does not fire, so the hover side menu's
 *  reorder action is expressed as two buttons around the public
 *  moveBlocksUp/moveBlocksDown commands instead.
 *
 *  No disabled state: BlockNote exposes no `canMoveBlock`, and at the document
 *  edge the command is a safe no-op (see utils/moveBlock). */
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useBlockNoteEditor, useComponentsContext } from '@blocknote/react'
import { moveBlockAtCursor } from '../../utils/moveBlock'

export function MoveBlockUpButton() {
  const editor = useBlockNoteEditor<any, any, any>()
  const Components = useComponentsContext()!

  if (!editor.isEditable) return null
  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      label="Move block up"
      mainTooltip="Move block up"
      icon={<ArrowUp size={14} />}
      onClick={() => moveBlockAtCursor(editor, 'up')}
    />
  )
}

export function MoveBlockDownButton() {
  const editor = useBlockNoteEditor<any, any, any>()
  const Components = useComponentsContext()!

  if (!editor.isEditable) return null
  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      label="Move block down"
      mainTooltip="Move block down"
      icon={<ArrowDown size={14} />}
      onClick={() => moveBlockAtCursor(editor, 'down')}
    />
  )
}
