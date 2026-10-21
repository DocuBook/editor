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

/** True when a markdown link target points at a vault note rather than the web:
 *  no URL scheme, and not protocol-relative (`//host`). Covers plain names,
 *  `./` and `../` (relative to the ACTIVE file's folder), and `/` (vault root).
 *
 *  Absolute filesystem paths carry a scheme or a leading `/`, so they never
 *  reach the vault branch; the backend's own path guard is the second line of
 *  defense. */
export const isVaultLinkUrl = (url: string): boolean =>
  !!url && !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('//')

/** Resolve a vault link target against the file that contains it, or null when
 *  it resolves to nothing (an anchor-only link).
 *
 *  Obsidian semantics: `/path` is vault-rooted, `./` and `../` are relative to
 *  the active file's folder, and `#anchor` / `?query` suffixes are stripped
 *  because they address a position inside the target, not another file. */
export function resolveVaultLinkTarget(url: string, activeFile: string): string | null {
  const target = url.split('#')[0].split('?')[0]
  if (!target) return null
  const curDir = activeFile.includes('/') ? activeFile.slice(0, activeFile.lastIndexOf('/')) : ''
  const raw = target.startsWith('/')
    ? target.replace(/^\/+/, '')
    : [curDir, target].filter(Boolean).join('/')
  const parts: string[] = []
  for (const seg of raw.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg === '.' || seg === '') continue
    else parts.push(seg)
  }
  return parts.join('/') || null
}