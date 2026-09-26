/** Fenced code block info string ⇄ its `language` and `title` parts.
 *
 *  A Markdown fence info string (` ```ts title="file.ts" `) is free-form, and
 *  BlockNote keeps it VERBATIM in the code block's `language` prop: the
 *  markdown parser copies the fence info in and the exporter writes the prop
 *  back out, so nothing about it is BlockNote's business. Two of our consumers
 *  need it split, though:
 *
 *  - the `language-*` class and the Shiki language want the LANGUAGE alone
 *    (`class="language-ts title=file.ts"` would be nonsense),
 *  - the block header wants the TITLE alone.
 *
 *  Keeping both in the one prop is what makes the round-trip work: editing the
 *  title rewrites the info string in place, and the code content is never part
 *  of it.
 */

/** Matches a `title=` token anywhere in an info string, quoted or bare. */
const TITLE_TOKEN = /(?:^|\s)title\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/

/** The `title=` token including its leading space, for removal. */
const TITLE_TOKEN_FULL = /(?:^|\s)title\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/

export interface CodeBlockInfo {
  /** First token of the info string — what Shiki and `language-*` get. */
  language: string
  /** Value of `title="…"`, or `''` when the info string has none. */
  title: string
}

export const parseCodeBlockInfo = (info: string): CodeBlockInfo => {
  const source = info ?? ''
  const match = TITLE_TOKEN.exec(source)
  const first = source.trim().split(/\s+/)[0] ?? ''

  return {
    // A language identifier is a bare word; a `key=value` token (title, an
    // highlight range, …) means this fence declared no language at all.
    language: first.includes('=') ? '' : first,
    title: match?.[1] ?? match?.[2] ?? match?.[3] ?? '',
  }
}

/** The info string with its `title` set to `title` (removed when empty).
 *
 *  Only the title token is replaced: any other info the user typed
 *  (` ```js showLineNumbers `) is preserved in place, and the language always
 *  stays first, which is what Markdown and Shiki expect. */
export const withCodeBlockTitle = (info: string, title: string): string => {
  const source = (info ?? '').trim()
  const { language } = parseCodeBlockInfo(source)
  const rest = (language ? source.slice(language.length) : source)
    .replace(TITLE_TOKEN_FULL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // A quote or a newline inside the value would break the token, and an info
  // string is a single line by definition.
  const value = title.replace(/["\r\n]/g, '').trim()

  return [language, rest, value ? `title="${value}"` : ''].filter(Boolean).join(' ')
}

/** The info string with its LANGUAGE set to `language` (removed when empty).
 *
 *  The mirror of withCodeBlockTitle: only the first token is replaced, so the
 *  title and any other info the user typed (` ```js showLineNumbers `) survive
 *  in place, and the language always stays first, which is what Markdown and
 *  Shiki expect. */
export const withCodeBlockLanguage = (info: string, language: string): string => {
  const source = (info ?? '').trim()
  const { language: current } = parseCodeBlockInfo(source)
  const rest = (current ? source.slice(current.length) : source)
    .replace(/\s+/g, ' ')
    .trim()
  // A language is a bare word: whitespace or a quote would split the info
  // string, and a `key=value` token would be read back as metadata rather than
  // a language (see the parse rule above).
  const value = (language ?? '').replace(/["'\s\r\n=]+/g, '')

  return [value, rest].filter(Boolean).join(' ')
}
