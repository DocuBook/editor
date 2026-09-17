/** Syntax highlighting for the code-like blocks (code, math, diagram).
 *
 *  BlockNote 0.54 owns the whole mechanism: `SyntaxHighlightingExtension`
 *  collects the node types whose spec declares `meta.highlight` (setup.ts), asks
 *  each of them for a language, and tokenizes their plain-text content with the
 *  Shiki highlighter whose factory we pass in (prosemirror-highlight
 *  decorations — the document text itself is never rewritten).
 *
 *  The factory is called lazily, the first time a block actually needs
 *  highlighting, so Shiki is behind a dynamic import: opening a document costs
 *  nothing until it contains a code block. shikiHighlighter.ts owns the Shiki
 *  configuration; this module only wires it into the extension.
 */
import { SyntaxHighlightingExtension } from '@blocknote/core'

export const syntaxHighlighting = SyntaxHighlightingExtension({
  createHighlighter: () => import('./shikiHighlighter').then(({ createEditorHighlighter }) => createEditorHighlighter()),
})
