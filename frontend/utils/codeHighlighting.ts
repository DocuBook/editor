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
 *
 *  While the AI writes, setup.ts's `highlight` returns no language at all: a
 *  streaming fence (` ```pyth `) must not make Shiki load a grammar for a
 *  language that does not exist yet.
 */
import { SyntaxHighlightingExtension } from '@blocknote/core'

export const syntaxHighlighting = SyntaxHighlightingExtension({
  createHighlighter: () => import('./shikiHighlighter').then(({ createEditorHighlighter }) => createEditorHighlighter()),
})

/** Re-run the Shiki decorations once the AI has stopped writing.
 *
 *  While it writes, setup.ts's `highlight` hands the extension no language, so
 *  prosemirror-highlight caches an EMPTY decoration set for every block parsed
 *  mid-stream — and its cache is keyed by (position, node, value-equal), so the
 *  same node would keep serving that empty result afterwards. Dropping those
 *  entries and dispatching the plugin's own refresh flag makes each block parse
 *  once more with the language it actually ended up with. */
export const refreshCodeHighlighting = (view: any) => {
  if (!view || view.isDestroyed) return
  // The plugin registers no public key, so find it by the name it uses:
  // prosemirror-highlight's own PluginKey string. Without the plugin (or a
  // future rename) the dispatch below still runs — it is also the unpause nudge
  // the wikilink decorations rely on.
  const plugin = view.state.plugins?.find((candidate: any) => String(candidate.key).includes('prosemirror-highlight'))
  const cache = plugin?.getState?.(view.state)?.cache
  if (cache?.cache) {
    for (const [position, entry] of cache.cache) {
      // Only entries with nothing to show are the pause's doing; a cached
      // decoration set is still valid and would just be recomputed.
      if (entry?.[1]?.length === 0) cache.remove(position)
    }
  }
  view.dispatch(view.state.tr.setMeta('prosemirror-highlight-refresh', true))
}
