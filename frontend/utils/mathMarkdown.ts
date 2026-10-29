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
 * Rules (mirroring BlockNote's math parser/exporter):
 * - `$$...$$` and `\\[...\\]` on their own line(s) → block math
 * - `$...$` and `\\(...\\)` within a line → inline math
 * - escaped `\\$` is a literal `$` (the backslash is dropped), and a delimiter
 *   after an escaped backslash `\\\\` is no delimiter
 * - code is left alone: fenced blocks, inline code spans, and `<pre>`/`<code>`
 *   in HTML input
 */

import { mapProse, protectInlineCode } from "./markdownCode";

function escapeMathLatex(latex: string): string {
  return latex.trim().replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Convert common LaTeX delimiters into BlockNote MathML HTML. Used for both
 * Markdown fallback output and HTML tool blocks before BlockNote parses them. */
export function mathDollarToMathML(markdown: string): string {
  /** Code is literal: `$(pwd)`, a regex's `\(…\)` or a LaTeX listing's `\[…\]`
   *  inside a fence or a code span must not become math. */
  return mapProse(markdown, (prose) => {
    const { text, spans } = protectInlineCode(prose, (i) => `${CODE}${i}${CODE}`);
    return convertMath(text).replace(
      new RegExp(`${CODE}(\\d+)${CODE}`, "g"),
      (_m, index) => spans[Number(index)] ?? _m,
    );
  });
}

const CODE = "\u0000CODE\u0000";

function convertMath(markdown: string): string {
  const ESC = "\u0000ESC\u0000";
  const MATH = "\u0000MATH\u0000";
  const BACKSLASH = "\u0000BS\u0000";
  /** `\\` is a literal backslash, so the `(`, `[` or `$` after it is no delimiter. */
  let out = markdown.replace(/\\\\/g, BACKSLASH).replace(/\\\$/g, ESC);
  const protectedMath: string[] = [];
  /** HTML input (AI tool blocks) marks code with tags instead of backticks. */
  out = out.replace(/<(pre|code)\b[\s\S]*?<\/\1>/gi, (match) => {
    protectedMath.push(match);
    return `${MATH}${protectedMath.length - 1}${MATH}`;
  });

  // Keep already-canonical tool HTML untouched while normalizing delimiters in
  // surrounding paragraph content.
  out = out.replace(/<math\b[\s\S]*?<\/math>/gi, (match) => {
    protectedMath.push(match);
    return `${MATH}${protectedMath.length - 1}${MATH}`;
  });

  const block = (latex: string) =>
    `<div><math display="block"><annotation encoding="application/x-tex">${escapeMathLatex(latex)}</annotation></math></div>`;
  const inline = (latex: string) =>
    `<math display="inline"><annotation encoding="application/x-tex">${escapeMathLatex(latex)}</annotation></math>`;

  out = out.replace(
    /(^|\n)\s*(?:\$\$|\\\[)([\s\S]*?)(?:\$\$|\\\])\s*(?=\n|$)/g,
    (_m, lead: string, latex: string) => `${lead}${block(latex)}\n`,
  );

  out = out.replace(
    /([\s\S]?)\\\(([^\n]*?)\\\)/g,
    (_m, before: string, latex: string) => `${before}${inline(latex)}`,
  );

  out = out.replace(
    /([\s\S]?)\$([^$\n]+)\$(?![\w$])/g,
    (_m, before: string, latex: string) =>
      /[\w$]/.test(before) ? _m : `${before}${inline(latex)}`,
  );

  out = out.replace(
    new RegExp(`${MATH}(\\d+)${MATH}`, 'g'),
    (_m, index) => protectedMath[Number(index)] ?? _m,
  );
  /** An escaped `\$` comes back as a plain `$`: it only had to dodge the math
   *  regexes above, and BlockNote's parser has no `$` syntax (nor a `\$`
   *  escape — it would show the backslash). */
  return out.replaceAll(ESC, "$").replaceAll(BACKSLASH, "\\\\");
}
