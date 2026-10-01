/** The sidebar's file clipboard: the context menu's Copy/Cut stores a tree row
 *  here and Paste reads it back.
 *
 *  Deliberately separate from `utils/clipboard` (the editor's TEXT clipboard)
 *  and, like it, in-app only — the OS clipboard is never touched, so file
 *  paste behaves identically on desktop and web. Copy/Cut themselves do no
 *  filesystem work; only Paste does, through `copy_path` / `move_path`.
 *
 *  The entry is scoped to the vault it came from: a path is relative, so after
 *  switching vaults the same string would resolve against a different tree and
 *  Paste would act on whatever happens to sit there. An entry from another
 *  vault is therefore not pastable at all. */

import type { FileInfo } from '../stores/vault'

/** `copy` duplicates the row and stays available for repeated pastes; `cut`
 *  moves it and is consumed by that one paste. */
export type ClipboardMode = 'copy' | 'cut'

export interface ClipboardItem {
  path: string
  name: string
  type: string
  mode: ClipboardMode
  /** Vault the row was taken from — the entry is meaningless outside it. */
  vaultPath: string
}

let item: ClipboardItem | null = null

function put(row: FileInfo, vaultPath: string, mode: ClipboardMode): void {
  item = { path: row.path, name: row.name, type: row.type, mode, vaultPath }
}

/** Remember a row for a later Paste; it can be pasted more than once. */
export function copyItem(row: FileInfo, vaultPath: string): void {
  put(row, vaultPath, 'copy')
}

/** Mark a row to be MOVED by the next Paste. */
export function cutItem(row: FileInfo, vaultPath: string): void {
  put(row, vaultPath, 'cut')
}

/** Drop the clipboard — a cut is spent the moment it is pasted. */
export function clearClipboardItem(): void {
  item = null
}

/** The Paste item's enabled state: is there anything from THIS vault to paste? */
export function hasClipboardItem(vaultPath: string): boolean {
  return item !== null && item.vaultPath === vaultPath
}

/** The row a menu Paste acts on (null when nothing was taken from this vault). */
export function peekClipboardItem(vaultPath: string): ClipboardItem | null {
  return item?.vaultPath === vaultPath ? item : null
}
