/** DOM contract of BlockNote's slash suggestion menu (v0.54).
 *  Root id + item ids come from `@blocknote/react` `SuggestionMenuWrapper`;
 *  the selected item carries `aria-selected` from `@blocknote/mantine`. */
const SUGGESTION_MENU_ID = 'bn-suggestion-menu'
const SUGGESTION_ITEM_ID_PREFIX = 'bn-suggestion-menu-item-'

/** True when a `beforeinput` is the user pressing Enter.
 *
 *  Mobile soft keyboards report Enter as a paragraph/line-break insertion (and
 *  some Androids as a literal `\n` text insertion) instead of a matching
 *  `keydown`, so the insertion type is the only reliable signal there. */
export const isEnterBeforeInput = (input: Pick<InputEvent, 'inputType' | 'data'>): boolean =>
  input.inputType === 'insertParagraph' ||
  input.inputType === 'insertLineBreak' ||
  (input.inputType === 'insertText' && input.data === '\n')

/** The slash-menu item BlockNote currently marks active, or null.
 *
 *  Resolution is scoped to the editor's contentEditable: the id is read from
 *  its `aria-activedescendant`, so an unrelated `[aria-activedescendant]`
 *  elsewhere in the app can never match. The `menu.contains` check rejects an
 *  id that resolves outside the menu (e.g. a colliding id). */
export const findActiveSuggestionItem = (editorDom: Element | null | undefined): HTMLElement | null => {
  const menu = document.getElementById(SUGGESTION_MENU_ID)
  if (!menu) return null
  const activeId = editorDom?.getAttribute('aria-activedescendant')
  const selected = (activeId?.startsWith(SUGGESTION_ITEM_ID_PREFIX) ? document.getElementById(activeId) : null)
    ?? menu.querySelector<HTMLElement>('.bn-suggestion-menu-item[aria-selected="true"]')
  if (!selected || !menu.contains(selected)) return null
  return selected
}
