// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { findActiveSuggestionItem, isEnterBeforeInput } from '../../../frontend/utils/slashMenuFallback'

const buildMenu = (items: Array<{ selected?: boolean }>) => {
  const menu = document.createElement('div')
  menu.id = 'bn-suggestion-menu'
  items.forEach((item, i) => {
    const el = document.createElement('div')
    el.className = 'bn-suggestion-menu-item'
    el.id = `bn-suggestion-menu-item-${i}`
    if (item.selected) el.setAttribute('aria-selected', 'true')
    menu.appendChild(el)
  })
  document.body.appendChild(menu)
  return menu
}

const buildEditorDom = (activeId?: string) => {
  const dom = document.createElement('div')
  if (activeId) dom.setAttribute('aria-activedescendant', activeId)
  document.body.appendChild(dom)
  return dom
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('isEnterBeforeInput', () => {
  it('accepts paragraph and line-break insertions', () => {
    expect(isEnterBeforeInput({ inputType: 'insertParagraph', data: null })).toBe(true)
    expect(isEnterBeforeInput({ inputType: 'insertLineBreak', data: null })).toBe(true)
  })

  it('accepts a literal newline text insertion', () => {
    expect(isEnterBeforeInput({ inputType: 'insertText', data: '\n' })).toBe(true)
  })

  it('rejects other insertions', () => {
    expect(isEnterBeforeInput({ inputType: 'insertText', data: 'a' })).toBe(false)
    expect(isEnterBeforeInput({ inputType: 'insertText', data: null })).toBe(false)
    expect(isEnterBeforeInput({ inputType: 'deleteContentBackward', data: null })).toBe(false)
  })
})

describe('findActiveSuggestionItem', () => {
  it('returns null when the slash menu is closed', () => {
    expect(findActiveSuggestionItem(buildEditorDom())).toBeNull()
  })

  it('resolves the item named by the editor editable', () => {
    const menu = buildMenu([{ selected: true }, {}])
    const dom = buildEditorDom('bn-suggestion-menu-item-1')
    expect(findActiveSuggestionItem(dom)).toBe(menu.children[1])
  })

  it('falls back to the aria-selected item when the active id is absent', () => {
    const menu = buildMenu([{}, { selected: true }])
    expect(findActiveSuggestionItem(buildEditorDom())).toBe(menu.children[1])
  })

  it('ignores an active id that is not a menu item id', () => {
    const menu = buildMenu([{ selected: true }])
    const dom = buildEditorDom('unrelated-widget')
    expect(findActiveSuggestionItem(dom)).toBe(menu.children[0])
  })

  it('rejects an active id that resolves outside the menu', () => {
    buildMenu([{}])
    const stray = document.createElement('div')
    stray.id = 'bn-suggestion-menu-item-99'
    document.body.appendChild(stray)
    const dom = buildEditorDom('bn-suggestion-menu-item-99')
    expect(findActiveSuggestionItem(dom)).toBeNull()
  })

  it('never reads aria-activedescendant from unrelated elements', () => {
    // Menu with no highlighted item: the only thing that could name an item is
    // a stray active id outside the editor editable, which must be ignored.
    buildMenu(Array.from({ length: 10 }, () => ({})))
    const stray = document.createElement('div')
    stray.setAttribute('aria-activedescendant', 'bn-suggestion-menu-item-9')
    document.body.appendChild(stray)
    expect(findActiveSuggestionItem(buildEditorDom())).toBeNull()
  })
})
