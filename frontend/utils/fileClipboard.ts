/** The sidebar's file clipboard: the context menu's Copy stores a tree row
 *  here and Paste reads it back.
 *
 *  Deliberately separate from `utils/clipboard` (the editor's TEXT clipboard)
 *  and, like it, in-app only — the OS clipboard is never touched, so file
 *  paste behaves identically on desktop and web. Copy itself does no
 *  filesystem work; only Paste does, through the `copy_path` command. */

import type { FileInfo } from '../stores/vault'

export interface CopiedItem {
  path: string
  name: string
  type: string
}

let copied: CopiedItem | null = null

/** Remember a row for a later Paste. */
export function copyItem(item: FileInfo): void {
  copied = { path: item.path, name: item.name, type: item.type }
}

/** The Paste item's enabled state: has a row been copied this session? */
export function hasCopiedItem(): boolean {
  return copied !== null
}

/** The row a menu Paste copies (null when nothing was copied). */
export function peekCopiedItem(): CopiedItem | null {
  return copied
}
