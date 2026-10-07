/**
 * WYSIWYG-only document snapshots.
 *
 * Markdown stays the single source of truth for a document. BlockNote formatting
 * that Markdown cannot represent — block colour, text alignment, and block
 * indentation — is dropped by `blocksToMarkdownLossy`, so re-deriving the editor
 * from Markdown on reload (vault resume, branch switch, code-mode round-trip)
 * loses it.
 *
 * This module persists a snapshot of the full block document as a DISPOSABLE
 * cache under `.docubook/wysiwyg/` in the vault, so it behaves identically on the
 * desktop app and the Docker server. A snapshot carries the exact body Markdown it
 * was serialized from; on load it is applied ONLY while that Markdown still
 * matches the file. Any external change (git, another editor, code mode) therefore
 * invalidates it and the document simply re-derives from Markdown.
 *
 * The failure mode is always "formatting resets" — never "formatting applied to
 * different content", because the guard is the Markdown itself.
 */
import { invoke } from '../lib/ipc'

export interface WysiwygSnapshot {
  /** The exact body Markdown this snapshot was serialized from — the guard. */
  markdown: string
  /** The full BlockNote document (`editor.document`). */
  blocks: unknown[]
}

/** Read the snapshot for `path`, or `null` when absent or corrupt. Best-effort:
 *  a cache read must never be able to fail opening a document. */
export async function readWysiwygSnapshot(path: string): Promise<WysiwygSnapshot | null> {
  try {
    const raw = await invoke<string>('read_wysiwyg_snapshot', { path })
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<WysiwygSnapshot>
    if (typeof parsed?.markdown !== 'string' || !Array.isArray(parsed?.blocks)) return null
    return { markdown: parsed.markdown, blocks: parsed.blocks }
  } catch {
    return null
  }
}

/** Persist the snapshot for `path`. Fire-and-forget: the Markdown file is the
 *  source of truth, so a failed cache write only costs formatting on the next
 *  reload — it is never surfaced to the user. */
export function writeWysiwygSnapshot(path: string, markdown: string, blocks: unknown[]): void {
  let payload: string
  try {
    const snapshot: WysiwygSnapshot = { markdown, blocks }
    payload = JSON.stringify(snapshot)
  } catch {
    return // a non-serializable document (should not happen) just skips the cache
  }
  void invoke('write_wysiwyg_snapshot', { path, content: payload }).catch(() => {})
}
