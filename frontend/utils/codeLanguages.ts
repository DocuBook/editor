/** The code block picker's dropdown options, taken from Shiki's own catalogue.
 *
 *  Loaded on demand — never while a code block merely renders. The header shows
 *  the fence token as-is (see setup.ts), so a raw markdown → WYSIWYG switch,
 *  which mounts every code block at once, does no async work and cannot race
 *  the block swap; the list is only needed once a dropdown actually opens.
 *  Options come from the same place the highlighter does, `shiki/langs`, so
 *  anything the picker offers is a language Shiki can tokenize. The import is
 *  dynamic, and the metadata map is the very chunk `shikiHighlighter.ts`
 *  already loads: a document gains nothing to its eager payload until a code
 *  block is on screen AND its picker is opened. */
export interface CodeLanguage {
  /** Option id: what a pick writes into the fence. */
  id: string
  /** Display name shown in the dropdown. */
  name: string
  /** Lowercased `id + name + aliases`, what the picker's search matches. A
   *  fence carries the token as typed (` ```ts `), so searching an alias has to
   *  land on `TypeScript` even though the option is labelled that way. */
  searchTerms: string
}

/** Shiki's plain-text language is special — no grammar, so it is absent from
 *  `bundledLanguagesInfo` — but it is BlockNote's `defaultLanguage`, and the
 *  picker has to be able to name it. Its aliases mirror BlockNote's own skip
 *  list (`text`, `none`, `plaintext`, `txt`), so a fence carrying any of them
 *  is findable. */
const PLAIN_TEXT_ALIASES = ['plaintext', 'txt', 'none']

const toLanguage = (id: string, name: string, aliases: string[] = []): CodeLanguage => ({
  id,
  name,
  searchTerms: [id, name, ...aliases].join(' ').toLowerCase(),
})

const PLAIN_TEXT = toLanguage('text', 'Text', PLAIN_TEXT_ALIASES)

let _languages: Promise<CodeLanguage[]> | null = null

export const loadCodeLanguages = (): Promise<CodeLanguage[]> => {
  if (!_languages) {
    _languages = import('shiki/langs').then(({ bundledLanguagesInfo }) => [
      PLAIN_TEXT,
      ...bundledLanguagesInfo
        .map(({ id, name, aliases }) => toLanguage(id, name, aliases))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ])
  }
  return _languages
}
