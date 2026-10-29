/**
 * Mounts the REAL app editor — `createBlockEditor` rendered through
 * `BlockNoteView` — in jsdom, for tests that must see what lands in the live DOM
 * rather than in a parsed document.
 *
 * Imported by component tests; never collected as a suite. The caller must
 * `vi.mock('…/frontend/lib/ipc')` itself (mocks are per test file): the editor's
 * `fileUrl` and `invoke` would otherwise try to reach a backend.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BlockNoteView } from '@blocknote/mantine'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/** jsdom lacks these; Mantine and ProseMirror's paste path need them. */
function polyfillJsdom() {
  ;(window as any).matchMedia ??= (query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  ;(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
  ;(globalThis as any).ClipboardEvent ??= class extends Event { clipboardData = null }
  ;(Range.prototype as any).getClientRects ??= () => []
  ;(Range.prototype as any).getBoundingClientRect ??= () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 })
  ;(Element.prototype as any).scrollIntoView ??= () => {}
}

/** What a paste puts on the clipboard: MIME type → data, and any files. */
export type ClipboardPayload = { data?: Record<string, string>; files?: File[] }

export interface AppEditor {
  editor: any
  root: Root
  /** Let React effects and the async `resolveFileUrl` callbacks run. */
  settle: () => Promise<void>
  /** Back to one empty paragraph with the caret in it. */
  reset: () => Promise<void>
  /** Dispatch a real `paste` event through the editor's clipboard handler (MIME
   *  priority and all). Resolves with whether the handler took the event. */
  paste: (payload: ClipboardPayload) => Promise<boolean>
}

export async function mountAppEditor(): Promise<AppEditor> {
  polyfillJsdom()
  const { createBlockEditor } = await import('../../frontend/utils/editorFactory')
  const editor: any = createBlockEditor('/vault', 'notes/a.md', '').editor
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(BlockNoteView, { editor, slashMenu: false, formattingToolbar: false, linkToolbar: false, sideMenu: false }))
  })
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  await settle()

  const reset = async () => {
    await act(async () => {
      editor.replaceBlocks(editor.document, [{ type: 'paragraph' }])
      editor.setTextCursorPosition(editor.document[0], 'start')
      editor.focus()
    })
  }

  const paste = async ({ data = {}, files = [] }: ClipboardPayload) => {
    const event = new (globalThis as any).ClipboardEvent('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: { types: [...Object.keys(data), ...(files.length ? ['Files'] : [])], getData: (type: string) => data[type] ?? '', files, items: [] },
    })
    await act(async () => { editor.domElement.dispatchEvent(event) })
    await settle()
    return event.defaultPrevented
  }

  return { editor, root, settle, reset, paste }
}
