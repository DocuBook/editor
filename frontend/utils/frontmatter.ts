/**
 * YAML frontmatter at the very start of a note.
 *
 * The editors only ever see the body: the frontmatter is kept raw on the tab and
 * put back in front of it on save. The same split is made when a file loads and
 * when code mode is edited, so it lives in one place.
 */

const FENCE = /^---[ \t]*$/

/** One YAML line of a mapping or sequence at the root: `key: value`, `key:`,
 *  `"quoted key": v`, or a `- item`. Indented lines continue the line above and
 *  comments are free, so only unindented lines are held to this. */
const ROOT_LINE = /^(?:(?:"[^"]*"|'[^']*'|[^\s:#"'][^:]*):(?:\s|$)|-(?:\s|$))/

/** Whether the lines between two `---` fences read as YAML. A document that
 *  merely opens with a divider and has another one further down
 *  (`---`, prose, `---`) is not frontmatter, and must not hide its first
 *  section from the editor. */
function looksLikeYaml(lines: string[]): boolean {
  return lines.every(line => !line.trim() || /^\s/.test(line) || line.startsWith('#') || ROOT_LINE.test(line))
}

/** Split `text` (LF line endings) into its frontmatter and body. The frontmatter
 *  is the exact leading bytes — both fences and the blank lines after them — so
 *  `frontmatter + body === text` always holds and a round trip cannot move a
 *  byte. Both parts are returned even when there is no frontmatter (`''`). */
export function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const lines = text.split('\n')
  if (!FENCE.test(lines[0])) return { frontmatter: '', body: text }
  const close = lines.findIndex((line, index) => index > 0 && FENCE.test(line))
  if (close < 0 || !looksLikeYaml(lines.slice(1, close))) return { frontmatter: '', body: text }
  let end = close + 1
  // The blank lines that follow belong to the frontmatter: the body (and the
  // WYSIWYG document built from it) starts at its first real line.
  while (end < lines.length - 1 && !lines[end].trim()) end++
  const frontmatter = lines.slice(0, end).join('\n') + (end < lines.length ? '\n' : '')
  return { frontmatter, body: lines.slice(end).join('\n') }
}
