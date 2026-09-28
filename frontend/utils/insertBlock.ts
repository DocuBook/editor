/** Insert-block action behind the compact formatting toolbar's `+` button.
 *
 *  Inserts a paragraph directly below the block at the text cursor — no slash
 *  menu. `/` already opens that menu, so a toolbar `+` that opened the same UI
 *  made "add a block" ambiguous between a click and a keystroke; typing a block
 *  type stays the menu's job (and the row's block-type select can convert the
 *  paragraph afterwards). Upstream AddBlockButton is not reused either way: it
 *  reads the hovered block from SideMenuExtension state (never set by a touch
 *  pointer, so it renders null here) and routes through the menu. */

/** Returns false — and inserts nothing — when there is no text cursor to anchor
 *  on or the insertion produced no block, so a click from a stale toolbar is a
 *  no-op instead of a thrown error. */
export function insertBlockAtCursor(editor: any): boolean {
  let block: any
  try {
    block = editor.getTextCursorPosition().block
  } catch {
    return false
  }
  if (!block) return false

  const inserted = editor.insertBlocks([{ type: 'paragraph' }], block, 'after')
  if (!inserted?.length) return false
  editor.setTextCursorPosition(inserted[0], 'start')
  return true
}
