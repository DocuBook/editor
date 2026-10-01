/** The sidebar's file clipboard: the context menu's Copy stores a tree row
 *  here and Paste reads it back.
 *
 *  Deliberately separate from `utils/clipboard` (the editor's TEXT clipboard)
 *  and, like it, in-app only — the OS clipboard is never touched, so file
 *  paste behaves identically on desktop and web. Copy itself does no
 *  filesystem work; only Paste does, through the `copy_path` command.
 *
 *  The copy is scoped to the vault it came from: a path is relative, so after
 *  switching vaults the same string would resolve against a different tree and
 *  Paste would copy whatever happens to sit there. A copy from another vault is
 *  therefore not pastable at all. */

import type { FileInfo } from '../stores/vault'

export interface CopiedItem {
  path: string
  name: string
  type: string
  /** Vault the row was copied from — the copy is meaningless outside it. */
  vaultPath: string
}

let copied: CopiedItem | null = null

/** Remember a row for a later Paste, scoped to the vault it belongs to. */
export function copyItem(item: FileInfo, vaultPath: string): void {
  copied = { path: item.path, name: item.name, type: item.type, vaultPath }
}

/** The Paste item's enabled state: has a row been copied from THIS vault? */
export function hasCopiedItem(vaultPath: string): boolean {
  return copied !== null && copied.vaultPath === vaultPath
}

/** The row a menu Paste copies (null when nothing was copied from this vault). */
export function peekCopiedItem(vaultPath: string): CopiedItem | null {
  return copied?.vaultPath === vaultPath ? copied : null
}
