/**
 * Code-aware helpers for the regex passes that run over a whole Markdown note
 * (math delimiters on load, bullet normalization on save). Code is literal: a
 * `$(pwd)`, `\(…\)` or JSDoc ` * ` line inside it must come out byte-for-byte.
 *
 * Deliberately lenient about where a fence may start — any indentation and any
 * blockquote prefix — so a fence nested in a list or a quote is still code. A
 * false positive only leaves some text untransformed; a false negative
 * corrupts code, so the cheap direction is the safe one.
 */

const FENCE = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})(.*)$/

export interface MarkdownSegment {
  code: boolean
  text: string
}

/** Split `markdown` into prose / fenced-code segments that concatenate back to
 *  the input exactly. An unclosed fence runs to the end, as CommonMark
 *  specifies. */
export function splitFencedCode(markdown: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = []
  let open: string | null = null
  let current = ''
  const flush = (code: boolean) => {
    if (current) segments.push({ code, text: current })
    current = ''
  }
  const lines = markdown.split('\n')
  for (let n = 0; n < lines.length; n++) {
    const bare = lines[n]
    const line = n < lines.length - 1 ? bare + '\n' : bare
    const match = FENCE.exec(bare.replace(/\r$/, ''))
    if (open === null) {
      if (match) { flush(false); open = match[1] }
      current += line
      continue
    }
    current += line
    // A closing fence repeats the opening character, at least as long, with nothing after it.
    if (match && match[1][0] === open[0] && match[1].length >= open.length && !match[2].trim()) {
      flush(true)
      open = null
    }
  }
  flush(open !== null)
  return segments
}

/** Apply `transform` to the prose of `markdown` only; fenced code passes through. */
export function mapProse(markdown: string, transform: (prose: string) => string): string {
  return splitFencedCode(markdown).map(s => (s.code ? s.text : transform(s.text))).join('')
}

/** Replace every inline code span in `prose` with `placeholder(i)` and return
 *  the spans so the caller can put them back. Follows CommonMark's rule: a run
 *  of N backticks closes only at the next run of exactly N, and an unmatched
 *  run is literal text. A span never crosses a blank line (paragraph break). */
export function protectInlineCode(prose: string, placeholder: (index: number) => string): { text: string; spans: string[] } {
  const spans: string[] = []
  let out = ''
  let i = 0
  while (i < prose.length) {
    const tick = prose.indexOf('`', i)
    if (tick === -1) { out += prose.slice(i); break }
    let runEnd = tick
    while (prose[runEnd] === '`') runEnd++
    const run = runEnd - tick
    // A backslash-escaped backtick is literal and opens nothing.
    if (tick > 0 && prose[tick - 1] === '\\') { out += prose.slice(i, tick + 1); i = tick + 1; continue }
    let close = -1
    let search = runEnd
    while (search < prose.length) {
      const next = prose.indexOf('`', search)
      if (next === -1) break
      let nextEnd = next
      while (prose[nextEnd] === '`') nextEnd++
      if (nextEnd - next === run) { close = next; break }
      search = nextEnd
    }
    if (close === -1 || /\n[ \t]*\n/.test(prose.slice(runEnd, close))) {
      out += prose.slice(i, runEnd)
      i = runEnd
      continue
    }
    out += prose.slice(i, tick) + placeholder(spans.length)
    spans.push(prose.slice(tick, close + run))
    i = close + run
  }
  return { text: out, spans }
}
