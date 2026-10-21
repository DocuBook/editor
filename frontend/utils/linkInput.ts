/** Link-target vs vault-note decision for the merged link input (formatting
 *  toolbar "Link" button + Ctrl/Cmd+K).
 *
 *  The popover used to carry two stacked inputs — a URL form and a separate
 *  "link a vault note" search. They are merged into one field, so the field's
 *  TEXT has to say which of the two it is: a link target (submit through
 *  `editLink`) or a note-name query (resolve through `wiki_suggest`, insert a
 *  `[[wikilink]]`).
 *
 *  Kept out of the component so the split is unit-testable without mounting a
 *  BlockNote toolbar. */

/** True when the text is a link TARGET rather than a note-name query: any URL
 *  scheme (`https:`, `mailto:`, `obsidian:`), a protocol-relative or
 *  vault-root path, a `./` `../` relative path, or a bare `#anchor`.
 *
 *  A bare host/path with no marker (`example.com`, `note.md`) is deliberately
 *  NOT a link: it is indistinguishable from a note name, so it goes through
 *  the suggestion search and only falls back to a link when nothing matches. */
export const looksLikeLink = (value: string): boolean =>
  /^[a-z][a-z0-9+.-]*:/i.test(value) ||
  value.startsWith('/') ||
  value.startsWith('./') ||
  value.startsWith('../') ||
  value.startsWith('#')

export type LinkInputAction =
  | { kind: 'wikilink'; title: string }
  | { kind: 'link'; target: string }

/** What Enter in the merged field should do, or null when the field is empty
 *  (nothing to link, nothing to search).
 *
 *  A note-name query only wins when it actually resolved to a suggestion;
 *  otherwise the text is submitted as-typed as a link target — so pasting a
 *  bare `example.com` still links. Link-looking text never consults the
 *  suggestions, so a URL typed while the list is populated can't be swallowed
 *  by a stale hit. `target` is the trimmed input (no `https://` forcing:
 *  vault-relative links must round-trip verbatim). */
export const resolveLinkInput = (
  value: string,
  results: readonly { title: string }[],
  selected: number,
): LinkInputAction | null => {
  const target = value.trim()
  if (!target) return null
  const hit = looksLikeLink(target) ? undefined : results[selected]
  return hit ? { kind: 'wikilink', title: hit.title } : { kind: 'link', target }
}

/** Schemes a note may hand to the OS opener or a browser tab. Notes are
 *  untrusted content: `javascript:`, `data:`, `file:` and custom app handlers
 *  are navigation/execution primitives, not links. */
const SAFE_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])

/** Normalize a URL for external opening, or null when it must not be opened.
 *
 *  Protocol-relative links (`//host/path`) are valid web URLs but arrive at the
 *  OS opener as a bare path and resolve against the app origin in a browser, so
 *  they are pinned to https instead of being passed through. The parsed form is
 *  returned (not the raw input) so callers cannot accidentally forward an
 *  unchecked string. */
export function safeExternalUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const candidate = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed
  let parsed: URL
  try { parsed = new URL(candidate) } catch { return null }
  if (!SAFE_EXTERNAL_PROTOCOLS.has(parsed.protocol)) return null
  return parsed.href
}
