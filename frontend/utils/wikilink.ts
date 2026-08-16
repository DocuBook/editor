/**
 * [[Wikilink]] helpers — single source of truth for parsing and opening links.
 * The editor styles them (ProseMirror decoration), shows a hover hint, and
 * handles clicks; all of them used to carry their own regex loop.
 */
import { invoke } from '../lib/ipc'
import { useEditorStore } from '../stores/editor'

/** Fresh regex per call — the global flag carries lastIndex, so a shared
 *  instance would be stateful across concurrent matches. */
const wikilinkRe = () => /\[\[([^\]]+)\]\]/g

/** Title of the [[wikilink]] spanning `offset` in `text`, or null. Offset is
 *  inclusive on both ends (a caret exactly at the edge still counts). */
export function findWikilinkAt(text: string, offset: number): string | null {
  const re = wikilinkRe()
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (offset >= m.index && offset <= m.index + m[0].length) return m[1]
  }
  return null
}

/** Resolve a [[title]] to its vault path and open it in the editor. No-op
 *  (silently) when the note doesn't exist. */
export function openWikilink(title: string): void {
  invoke<string>('wiki_resolve', { title })
    .then(path => { if (path) useEditorStore.getState().openFile(path, path.split('/').pop() || path) })
    .catch(() => {})
}