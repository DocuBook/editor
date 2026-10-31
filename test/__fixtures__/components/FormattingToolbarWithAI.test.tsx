// @vitest-environment jsdom

/** Which row FormattingToolbarWithAI renders: the desktop bubble, the compact
 *  (<640px web) bubble, or the IME strip (`uiMode` "mobile"). Pins the trailing
 *  control each one gets and the compact order, where alignment and indent go
 *  to the scrolled-off tail. A live BlockNote editor cannot be constructed
 *  headless, so the editor, the components and the row's child buttons are
 *  stubs that render a marker each. */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const stubs = vi.hoisted(() => ({
  uiMode: undefined as string | undefined,
  editor: { isEditable: true, domElement: undefined, prosemirrorState: { selection: { from: 0, to: 0 } } },
}))

/** Upstream's items, in upstream order, as keyed elements like the real ones. */
const ITEM_KEYS = [
  'blockTypeSelect',
  'boldStyleButton',
  'italicStyleButton',
  'textAlignLeftButton',
  'textAlignCenterButton',
  'textAlignRightButton',
  'colorStyleButton',
  'nestBlockButton',
  'unnestBlockButton',
  'createLinkButton',
]

vi.mock('@blocknote/react', () => {
  const Button = ({ label }: any) => <button type="button" data-marker={label} />
  const Pass = ({ children }: any) => <>{children}</>
  return {
    useBlockNoteEditor: () => stubs.editor,
    useUIMode: () => stubs.uiMode,
    useExtension: () => ({ store: { setState: vi.fn() }, showSelection: vi.fn(), editLink: vi.fn() }),
    useEditorState: () => ({ url: '', text: '', range: { from: 0, to: 0 } }),
    useComponentsContext: () => ({
      FormattingToolbar: {
        Root: ({ className, children }: any) => <div data-root={className}>{children}</div>,
        Button,
      },
      Generic: {
        Toolbar: { Button },
        Menu: { Root: Pass },
        Popover: { Root: Pass, Trigger: Pass, Content: () => null },
      },
      SuggestionMenu: { Root: Pass, Item: () => null },
    }),
    usePortalElement: () => undefined,
    ComponentsContext: { Provider: Pass },
    FormattingToolbar: ({ children }: any) => <div data-root="FormattingToolbar">{children}</div>,
    blockTypeSelectItems: () => [],
    getFormattingToolbarItems: () => ITEM_KEYS.map(key => <span key={key} data-marker={key} />),
    DeleteLinkButton: () => null,
    ScreenReaderOnlySubmit: () => null,
  }
})
vi.mock('@blocknote/core/extensions', () => ({
  LinkToolbarExtension: {},
  FormattingToolbarExtension: {},
  ShowSelectionExtension: {},
}))
vi.mock('../../../frontend/utils/aiMenu', () => ({
  getDefaultAIMenuItems: () => [],
  getAIDictionary: () => ({ formatting_toolbar: { ai: { tooltip: 'AI' } } }),
}))
vi.mock('../../../frontend/stores/aiChat', () => ({ useAiChat: () => vi.fn() }))
vi.mock('../../../frontend/stores/editor', () => ({ useEditorStore: () => undefined }))
vi.mock('../../../frontend/utils/aiBlocks', () => ({}))
vi.mock('../../../frontend/lib/ipc', () => ({ invoke: vi.fn() }))
vi.mock('../../../frontend/components/editor/ToolbarScrollButton', () => ({
  ToolbarScrollButton: () => <span data-marker="ToolbarScrollButton" />,
}))
vi.mock('../../../frontend/components/editor/DeleteBlockButton', () => ({
  DeleteBlockButton: () => <span data-marker="DeleteBlockButton" />,
}))
vi.mock('../../../frontend/components/editor/InsertBlockButton', () => ({
  InsertBlockButton: () => <span data-marker="InsertBlockButton" />,
}))
vi.mock('../../../frontend/components/editor/MoveBlockButtons', () => ({
  MoveBlockUpButton: () => <span data-marker="MoveBlockUpButton" />,
  MoveBlockDownButton: () => <span data-marker="MoveBlockDownButton" />,
}))

import { FormattingToolbarWithAI } from '../../../frontend/components/editor/linkToolbar'

let container: HTMLDivElement
let root: Root

/** The row's markers in document order. */
const markers = () => [...container.querySelectorAll('[data-marker]')].map(el => el.getAttribute('data-marker'))
const rootKind = () => container.querySelector('[data-root]')?.getAttribute('data-root')

const BLOCK_ACTIONS = ['InsertBlockButton', 'MoveBlockUpButton', 'MoveBlockDownButton']
const TAIL = ['textAlignLeftButton', 'textAlignCenterButton', 'textAlignRightButton', 'nestBlockButton', 'unnestBlockButton']
const LEAD = ['blockTypeSelect', 'boldStyleButton', 'italicStyleButton', 'colorStyleButton']
const UPSTREAM = ITEM_KEYS.filter(key => key !== 'createLinkButton')

beforeEach(() => {
  stubs.uiMode = undefined
  stubs.editor.isEditable = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('FormattingToolbarWithAI', () => {
  it('renders the desktop bubble in upstream order with no pinned control', () => {
    act(() => root.render(<FormattingToolbarWithAI blockActions />))

    expect(rootKind()).toBe('FormattingToolbar')
    expect(markers()).toEqual([...BLOCK_ACTIONS, ...UPSTREAM, 'Link', 'AI'])
  })

  it('moves alignment and indent to the tail of the compact row and pins the chevron', () => {
    act(() => root.render(<FormattingToolbarWithAI compact blockActions />))

    expect(rootKind()).toContain('formatting-toolbar-scroll')
    expect(markers()).toEqual([...LEAD, 'Link', 'AI', ...BLOCK_ACTIONS, ...TAIL, 'ToolbarScrollButton'])
  })

  it('pins the delete button on the compact IME strip instead of the chevron', () => {
    stubs.uiMode = 'mobile'
    act(() => root.render(<FormattingToolbarWithAI compact blockActions />))

    expect(rootKind()).toContain('formatting-toolbar-scroll')
    expect(markers()).toEqual([...LEAD, 'Link', 'AI', ...BLOCK_ACTIONS, ...TAIL, 'DeleteBlockButton'])
  })

  it('keeps the desktop order on a wide IME strip, still scrolling with the delete button', () => {
    stubs.uiMode = 'mobile'
    act(() => root.render(<FormattingToolbarWithAI blockActions />))

    expect(rootKind()).toContain('formatting-toolbar-scroll')
    expect(markers()).toEqual([...BLOCK_ACTIONS, ...UPSTREAM, 'Link', 'AI', 'DeleteBlockButton'])
  })

  it('renders nothing while the editor is read-only', () => {
    stubs.editor.isEditable = false
    act(() => root.render(<FormattingToolbarWithAI compact blockActions />))

    expect(container.childElementCount).toBe(0)
  })
})
