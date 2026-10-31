/** Delete-block action behind the IME toolbar's trash button — the side menu's
 *  "Delete" (drag handle menu), which a touch pointer cannot reach: the side menu
 *  is hover-driven and the shells without it have no other way to drop a whole
 *  block short of selecting and erasing its text, which leaves the block behind.
 *
 *  Targets the selected blocks, or the block at the text cursor. The caret is
 *  handed to a neighbour first-come: the end of the previous sibling, the start
 *  of the next one, then the end of the parent — so the keyboard stays up on a
 *  block the reader can keep typing in. A deletion that would leave no block to
 *  land on (the whole document) replaces the targets with one empty paragraph
 *  instead: the document cannot hold zero blocks. */

/** Returns false — and deletes nothing — when there is no selection or text
 *  cursor to act on, so a click from a stale toolbar is a no-op. */
export function deleteBlockAtCursor(editor: any): boolean {
  let targets: any[] = []
  try {
    const selected = editor.getSelection?.()?.blocks
    targets = selected?.length ? selected : [editor.getTextCursorPosition().block].filter(Boolean)
  } catch {
    targets = []
  }
  if (!targets.length) return false

  const first = targets[0]
  const last = targets[targets.length - 1]
  const prev = editor.getPrevBlock?.(first)
  const next = prev ? undefined : editor.getNextBlock?.(last)
  const parent = prev || next ? undefined : editor.getParentBlock?.(first)

  /* Upstream's NestBlockButton does the same: the click may have taken focus
     (mouse), and the block commands act on the ProseMirror selection either way. */
  editor.focus()
  if (!prev && !next && !parent) {
    const [blank] = editor.replaceBlocks(targets, [{ type: 'paragraph' }]).insertedBlocks
    if (blank) editor.setTextCursorPosition(blank, 'start')
    return true
  }

  editor.removeBlocks(targets)
  /* A neighbour without inline content (an image, a divider) takes no caret;
     the selection ProseMirror mapped across the removal is then kept. */
  try {
    if (prev) editor.setTextCursorPosition(prev, 'end')
    else if (next) editor.setTextCursorPosition(next, 'start')
    else editor.setTextCursorPosition(parent, 'end')
  } catch { /* keep the mapped selection */ }
  return true
}
