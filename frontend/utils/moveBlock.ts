/** Move the block at the text cursor one position up/down — the block-actions
 *  stand-in for the side menu's drag handle, which is HTML5 drag-and-drop and
 *  never fires from a touch pointer.
 *
 *  No block identifier is passed to the move commands: without one they move the
 *  selected blocks AND carry the selection along, so the caret stays in the block
 *  it started in (passing one moves the block but leaves the selection behind).
 *  Document edges are the commands' own behaviour — a no-op at the first/last
 *  top-level block, an unnest for the first nested one — with no public
 *  `canMoveBlock` to disable on, exactly like upstream's Mod+Shift+Arrow
 *  shortcuts, which drive the same commands unguarded. */

/** Returns false — and moves nothing — when there is no selection or text
 *  cursor to move, so a click from a stale toolbar is a no-op. */
export function moveBlockAtCursor(editor: any, direction: 'up' | 'down'): boolean {
  let hasTarget = false
  try {
    hasTarget = !!editor.getSelection?.()?.blocks?.length || !!editor.getTextCursorPosition().block
  } catch {
    hasTarget = false
  }
  if (!hasTarget) return false
  /* Upstream's NestBlockButton does the same: the click may have taken focus
     (mouse), and the move commands act on the ProseMirror selection either way. */
  editor.focus()
  if (direction === 'up') editor.moveBlocksUp()
  else editor.moveBlocksDown()
  return true
}
