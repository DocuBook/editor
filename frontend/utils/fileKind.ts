/**
 * File extension contract — single source of truth for how files are handled.
 *
 * Three tiers:
 * - `markdown` — .md/.mdx: WYSIWYG editable (Editor/Code toggle + AI + frontmatter).
 *   .mdx is plain CommonMark + frontmatter, identical to .md for this editor.
 * - `binary` — images etc: inline preview (read-only, never read as UTF-8 text).
 * - `text` — anything else readable: plain-text viewer (read-only).
 */
export const MARKDOWN_EXTENSIONS = ['.md', '.mdx']
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.bmp', '.avif']
/** Other non-text types — preview fallback (EyeOff placeholder). */
export const OTHER_BINARY_EXTENSIONS = ['.pdf', '.mp3', '.mp4', '.mov', '.avi', '.zip', '.tar', '.gz', '.rar', '.exe', '.dmg', '.pkg', '.bin']

export type FileKind = 'markdown' | 'binary' | 'text'

export function fileKind(path: string): FileKind {
  const lower = path.toLowerCase()
  if (MARKDOWN_EXTENSIONS.some(ext => lower.endsWith(ext))) return 'markdown'
  if (IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext))) return 'binary'
  if (OTHER_BINARY_EXTENSIONS.some(ext => lower.endsWith(ext))) return 'binary'
  return 'text'
}

/** True when the file must never be read as UTF-8 text (binary or image). */
export const isBinaryPath = (path: string): boolean => fileKind(path) === 'binary'


/** UI-level file tier — maps the extension contract onto editor modes:
 *  markdown → wysiwyg (Editor/Code toggle + AI), binary/text stay as-is. */
export type EditorFileKind = 'wysiwyg' | 'binary' | 'text'
export const editorFileKind = (path: string): EditorFileKind =>
  fileKind(path) === 'binary' ? 'binary' : fileKind(path) === 'markdown' ? 'wysiwyg' : 'text'
