/**
 * Math `$`/`$$` → MathML-HTML converter for BlockNote markdown import.
 *
 * BlockNote 0.54's math blocks export as `$$...$$` (block) and `$...$`
 * (inline), but its custom markdown parser has no `$` handling — so a file
 * saved with math opens as plain text instead of rendering. The parse rules
 * (math-block) DO recognize `<math display="block|inline"><annotation
 * encoding="application/x-tex">latex</annotation></math>`, so we pre-process
 * the markdown into that shape before `tryParseMarkdownToBlocks`.
 *
 * Rules (mirroring the exporter):
 * - `$$...$$` on its own line(s) → block math
 * - `$...$` within a line → inline math (no newlines inside)
 * - escaped `\$` is left alone
 */

/** Convert `$$...$$` and `$...$` spans into `<math>` HTML for markdown import. */
export function mathDollarToMathML(markdown: string): string {
  // Escape sequence: first protect `\$` so it isn't treated as a delimiter.
  const ESC = '\u0000ESC\u0000'
  let out = markdown.replace(/\\\$/g, ESC)

  // Block math: $$...$$ possibly spanning multiple lines, on its own line(s).
  // Matches the exporter's serializeMathBlock shape (lines wrapped in $$).
  // Wrapped in <div> — blocknote's markdown converter only has inline HTML
  // passthrough, and HTMLToBlocks needs the <math display="block"> inside a
  // block wrapper to produce a real mathBlock (verified in browser: plain
  // <math> collapses into the paragraph; <div><math> → mathBlock).
  out = out.replace(
    /(^|\n)\s*\$\$(.*?)\$\$\s*(?=\n|$)/gs,
    (_m, lead: string, latex: string) =>
      `${lead}<div><math display="block"><annotation encoding="application/x-tex">${latex.trim()}</annotation></math></div>\n`,
  )

  // Inline math: $...$ — no newlines inside, $ not adjacent to another $.
  // NO lookbehind: (?<!...) is Safari 15 (WKWebView) fatal — replaced with a
  // capture of the preceding char + a callback guard (same semantics).
  out = out.replace(
    /([\s\S]?)\$([^$\n]+)\$(?![\w$])/g,
    (_m, before: string, latex: string) =>
      /[\w$]/.test(before)
        ? _m // delimiter adjacent to word char/$ → not math
        : `${before}<math display="inline"><annotation encoding="application/x-tex">${latex.trim()}</annotation></math>`,
  )

  // Restore escaped dollar signs.
  return out.replaceAll(ESC, '\\$')
}
