import { createElement, Fragment, useRef, useState, useSyncExternalStore } from 'react'
import { Select } from '@mantine/core'
import { createHeadingBlockSpec, BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs, createExtension } from '@blocknote/core'
import { createCodeBlockConfig, parsePreCode, parsePreCodeContent } from '@blocknote/core/blocks'
import { createReactBlockSpec, createReactInlineContentSpec } from '@blocknote/react'
import {
  BlockMathMLElement,
  MathBlockInputRulesExtension,
  MathBlockPreviewWithPopup,
  MathInlineInputRulesExtension,
  MathInlinePreviewWithPopup,
  createMathBlockConfig,
  InlineMathMLElement,
  mathInlineContentConfig,
  parseBlockMathMLContent,
  parseBlockMathMLElement,
  parseInlineMathMLContent,
  parseInlineMathMLElement,
} from '@blocknote/math-block'
import { createDiagramBlockConfig, parseDiagramCodeContent, parseDiagramCodeElement } from '@blocknote/diagram-block'
import { CachedDiagramPreviewWithPopup } from './CachedDiagramPreview'
import { Plugin } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { findWikilinkAt, openWikilink } from '../../utils/wikilink'
import { parseCodeBlockInfo, withCodeBlockLanguage, withCodeBlockTitle } from '../../utils/codeBlockInfo'
import { loadCodeLanguages } from '../../utils/codeLanguages'

let _previewRenderingPaused = false
const _previewRenderingListeners = new Set<() => void>()

export const setPreviewRenderingPaused = (paused: boolean) => {
  if (_previewRenderingPaused === paused) return
  _previewRenderingPaused = paused
  _previewRenderingListeners.forEach((listener) => listener())
}

const usePreviewRenderingPaused = () => useSyncExternalStore(
  (listener) => { _previewRenderingListeners.add(listener); return () => _previewRenderingListeners.delete(listener) },
  () => _previewRenderingPaused,
)

/** Keep existing source previews mounted while AI updates their source. New
 * previews use source view until rendering is enabled. */
/* oxlint-disable react/refs -- deliberate render-time ref caching freezes preview
 * components during AI writing; moving these reads/writes into effects
 * reintroduces the preview flicker this wrapper exists to prevent. */
function StableSourcePreview({ paused, props, language, codeInfo, Preview, fallback }: { paused: boolean; props: any; language: string; codeInfo: string; Preview: any; fallback: 'block' | 'inline' }) {
  const stableProps = useRef<any | null>(null)
  const stableElement = useRef<any | null>(null)
  const latestContentRef = useRef(props.contentRef)
  const stableContentRef = useRef<((node: HTMLElement | null) => void) | null>(null)
  const latestNode = useRef(props.node)
  const latestGetPos = useRef(props.getPos)
  const stableNode = useRef<any | null>(null)
  const stableGetPos = useRef<(() => number | undefined) | null>(null)

  latestContentRef.current = props.contentRef
  latestNode.current = props.node
  latestGetPos.current = props.getPos
  if (!stableContentRef.current) stableContentRef.current = (node) => latestContentRef.current(node)
  // Keep inline popup position live without passing changing props into frozen preview.
  if (fallback === 'inline' && !stableNode.current) stableNode.current = { get nodeSize() { return latestNode.current.nodeSize } }
  if (fallback === 'inline' && !stableGetPos.current) stableGetPos.current = () => latestGetPos.current()

  if (!paused) {
    stableProps.current = props
    stableElement.current = null
  }

  if (paused && !stableElement.current) {
    if (!stableProps.current) {
      const code = createElement('code', {
        className: language ? `language-${language}` : undefined,
        'data-language': codeInfo || undefined,
        ref: stableContentRef.current,
      })
      stableElement.current = fallback === 'inline' ? code : createElement('pre', null, code)
    } else {
      const previewProps = {
        ...stableProps.current,
        contentRef: stableContentRef.current,
        ...(fallback === 'inline' ? { node: stableNode.current, getPos: stableGetPos.current } : {}),
      }
      stableElement.current = createElement(Preview, previewProps)
    }
  }

  return paused ? stableElement.current : createElement(Preview, props)
}
/* oxlint-enable react/refs */


function createStablePreview(Preview: any, language: string | ((props: any) => string), fallback: 'block' | 'inline', codeInfo?: (props: any) => string) {
  return function StableWrapper(props: any) {
    const lang = typeof language === 'function' ? language(props) : language
    return createElement(StableSourcePreview, { paused: usePreviewRenderingPaused(), props, language: lang, codeInfo: codeInfo ? codeInfo(props) : lang, Preview, fallback })
  }
}

const StableDiagramPreview = createStablePreview(CachedDiagramPreviewWithPopup, 'mermaid', 'block')
const StableMathBlockPreview = createStablePreview(MathBlockPreviewWithPopup, 'latex', 'block')
const StableMathInlinePreview = createStablePreview(MathInlinePreviewWithPopup, 'latex', 'inline')

const mathBlockSpec = createReactBlockSpec(createMathBlockConfig, {
  meta: { code: true, defining: true, isolating: false, highlight: () => 'latex', hasPreview: true, hardBreakShortcut: 'shift+enter' },
  parse: parseBlockMathMLElement,
  parseContent: parseBlockMathMLContent,
  render: StableMathBlockPreview,
  toExternalHTML: BlockMathMLElement,
}, [MathBlockInputRulesExtension])

const mathInlineSpec = createReactInlineContentSpec(mathInlineContentConfig, {
  meta: { code: true, highlight: () => 'latex', hasPreview: true },
  parse: parseInlineMathMLElement,
  parseContent: parseInlineMathMLContent,
  render: StableMathInlinePreview,
  toExternalHTML: InlineMathMLElement,
}, [MathInlineInputRulesExtension])

const diagramSpec = createReactBlockSpec(createDiagramBlockConfig, {
  meta: { code: true, defining: true, isolating: false, highlight: () => 'mermaid', hasPreview: true, hardBreakShortcut: 'enter' },
  parse: parseDiagramCodeElement,
  parseContent: parseDiagramCodeContent,
  runsBefore: ['codeBlock'],
  render: StableDiagramPreview,
  toExternalHTML: (props) => createElement('pre', null, createElement('code', { className: 'language-mermaid', 'data-language': 'mermaid', ref: props.contentRef })),
})

/** Clicks and shortcut keys inside the header belong to the field, not the
 *  document: ProseMirror moves its own selection on mousedown and reads the
 *  global keymap, so without stopping those here a click on the title or the
 *  picker would reselect the code block, and ⌘K / ⌘⇧E would fire while a title
 *  is being typed.
 *
 *  PLAIN keys are deliberately left alone: the language picker is driven by
 *  React handlers (ArrowUp/Down, Enter, Escape) and ProseMirror skips those keys
 *  itself (see codeBlockShortcuts), so stopping them here would starve the
 *  picker's keyboard controls. Bound once per node — the callback identity
 *  changes every render, so re-binding is guarded by a data flag rather than a
 *  ref. */
const keepEventsLocal = (node: HTMLElement | null) => {
  if (!node || node.dataset.boundEvents === '1') return
  node.dataset.boundEvents = '1'
  for (const type of ['mousedown', 'click'] as const) {
    node.addEventListener(type, (event) => event.stopPropagation())
  }
  node.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) event.stopPropagation()
  })
}

/** True when a DOM event started inside one of the header's own fields — the
 *  title input or the language picker's input. */
export const isCodeBlockHeaderField = (target: unknown) =>
  !!(target as HTMLElement | null)?.closest?.('.code-block-header')

/** Claims the keys typed into those fields, so ProseMirror's keymap (which sits
 *  on an ancestor of the node view) does not run the code block's own Tab/Enter/
 *  Delete commands — inserting spaces or splitting the block while a title is
 *  being written. Claiming them as a DOM handler rather than stopping their
 *  propagation keeps the default action: the field still receives the character,
 *  and the event keeps bubbling, so React sees it and the picker's keyboard
 *  controls work. */
const headerFieldKeys = new Plugin({
  props: {
    handleDOMEvents: {
      keydown: (_view, event) => isCodeBlockHeaderField(event.target),
    },
  },
})

/** The header's language control: a closed choice over the grammars Shiki can
 *  actually load (see codeLanguages.ts) — unlike the title, which stays free
 *  text. Mantine's Select keeps the list inside the app window (a portaled,
 *  scrollable popover that flips and shifts against the viewport), whereas a
 *  native `<select>` hands all 243 options to an OS menu, which macOS draws
 *  past the window bounds. BlockNote's own picker (`createLanguageSelect`) is a
 *  native `<select>` as well, and on top of that it throws for a value that is
 *  not exactly one of its `supportedLanguages` keys and writes the bare
 *  language into the prop — dropping the `title="…"` this header keeps in the
 *  same info string. */
function CodeBlockLanguage({ editor, block, info, language }: any) {
  const [languages, setLanguages] = useState<any>(null)

  // The control shows and writes the fence token AS-IS: no catalogue lookup, no
  // alias mapping. Rendering therefore never waits on an async import, which
  // matters on a raw markdown → WYSIWYG switch: every code block mounts at
  // once, and each one waiting on the same chunk raced the block swap. The
  // list only fills the dropdown, so it loads on first open.
  const token: string = language || 'text'
  const terms = new Map<string, string>()
  for (const option of languages ?? []) terms.set(option.id, option.searchTerms)
  const data = [
    { value: token, label: token },
    ...(languages ?? [])
      .filter((option: any) => option.id !== token)
      .map((option: any) => ({ value: option.id, label: option.name })),
  ]

  // BlockNote's own popup container, which sits inside the `bn-mantine` wrapper
  // that carries `data-mantine-color-scheme`. Portaling to document.body (the
  // default) put the list outside that scope, where Mantine's variables fall
  // back to the light defaults — a white dropdown inside a dark editor. The
  // getter is absent outside a mounted editor (tests), hence the fallback.
  const portalTarget = editor?.portalElement

  return createElement(Select<string>, {
    className: 'code-block-language',
    classNames: { input: 'code-block-language-input' },
    variant: 'unstyled',
    size: 'xs',
    value: token,
    data,
    searchable: true,
    allowDeselect: false,
    // The list scrolls inside the dropdown instead of running past the window;
    // the popover's default flip/shift middlewares keep it in the viewport.
    maxDropdownHeight: 280,
    comboboxProps: portalTarget ? { portalProps: { target: portalTarget } } : undefined,
    disabled: !editor.isEditable,
    'aria-label': 'Code block language',
    nothingFoundMessage: 'No language found',
    onDropdownOpen: () => { if (!languages) loadCodeLanguages().then(setLanguages) },
    // Matches the fence-facing tokens too: `js`, `ts` and `jsonc` are ids or
    // Shiki aliases, not the labels ("JavaScript", "TypeScript",
    // "JSON with Comments") the default label-only filter would search.
    filter: ({ options, search, limit }: any) => {
      const query = search.trim().toLowerCase()
      if (!query) return options
      return options
        .filter((option: any) => (terms.get(option?.value) ?? String(option?.label ?? '')).toLowerCase().includes(query))
        .slice(0, limit)
    },
    onChange: (value: string | null) => {
      if (value) editor.updateBlock(block.id, { props: { language: withCodeBlockLanguage(info, value) } })
    },
  })
}

/** The block header: the fence language Shiki highlights as, plus the optional
 *  `title="…"` from the fence info string. Chrome, not content — both live in
 *  the block's `language` prop, so renaming a block never touches its code and
 *  the fence round-trips as typed. */
function CodeBlockHeader({ editor, block, info, language, title }: any) {
  return createElement('div', { className: 'code-block-header', contentEditable: false, ref: keepEventsLocal }, [
    createElement(CodeBlockLanguage, { key: 'language', editor, block, info, language }),
    createElement('input', {
      key: 'title',
      className: 'code-block-title',
      placeholder: 'Add title…',
      value: title,
      spellCheck: false,
      'aria-label': 'Code block title',
      onChange: (event: any) => editor.updateBlock(block.id, {
        props: { language: withCodeBlockTitle(info, event.target.value) },
      }),
    }),
  ])
}

/** Code block source view: pre > code, same shape as vanilla renderer, with the
 *  block header on top. Exported for the header's DOM-contract test. */
export function CodeBlockSource(props: any) {
  const info: string = props.block?.props?.language ?? ''
  const { language, title } = parseCodeBlockInfo(info)
  return createElement(Fragment, null,
    createElement(CodeBlockHeader, {
      key: 'header',
      editor: props.editor,
      block: props.block,
      info,
      language,
      title,
    }),
    createElement('pre', { key: 'code' }, createElement('code', {
      className: language ? `language-${language}` : undefined,
      'data-language': info || undefined,
      ref: props.contentRef,
    })),
  )
}

/** Frozen wrapper (see StableSourcePreview) around the code block source view —
 *  exported so the AI-writing freeze behaviour is testable. */
export const StableCodeBlockPreview = createStablePreview(
  CodeBlockSource,
  (p: any) => parseCodeBlockInfo(p.block?.props?.language ?? '').language,
  'block',
  (p: any) => p.block?.props?.language ?? '',
)

/** Exported for the header-key test (the guard is what keeps ProseMirror's
 *  commands out of the header's fields). */
export const codeBlockShortcuts = createExtension({
  key: 'codeBlockKeyboardShortcuts',
  prosemirrorPlugins: [headerFieldKeys],
  keyboardShortcuts: {
    Delete: ({ editor }: any) => {
      return editor.transact((tr: any) => {
        const { block } = editor.getTextCursorPosition()
        if (block.type !== 'codeBlock') return false
        const { $from } = tr.selection
        if (!$from.parent.textContent) {
          editor.removeBlocks([block])
          return true
        }
        return false
      })
    },
    Tab: ({ editor }: any) => {
      return editor.transact((tr: any) => {
        const { block } = editor.getTextCursorPosition()
        if (block.type !== 'codeBlock') return false
        tr.insertText('  ')
        return true
      })
    },
    Enter: ({ editor }: any) => {
      return editor.transact((tr: any) => {
        const { block, nextBlock } = editor.getTextCursorPosition()
        if (block.type !== 'codeBlock') return false
        const { $from } = tr.selection
        const isAtEnd = $from.parentOffset === $from.parent.nodeSize - 2
        const endsWithDoubleNewline = $from.parent.textContent.endsWith('\n\n')
        if (isAtEnd && endsWithDoubleNewline) {
          tr.delete($from.pos - 2, $from.pos)
          if (nextBlock) {
            editor.setTextCursorPosition(nextBlock, 'start')
            return true
          }
          const [newBlock] = editor.insertBlocks([{ type: 'paragraph' }], block, 'after')
          editor.setTextCursorPosition(newBlock, 'start')
          return true
        }
        tr.insertText('\n')
        return true
      })
    },
    'Shift-Enter': ({ editor }: any) => {
      return editor.transact(() => {
        const { block } = editor.getTextCursorPosition()
        if (block.type !== 'codeBlock') return false
        const [newBlock] = editor.insertBlocks([{ type: 'paragraph' }], block, 'after')
        editor.setTextCursorPosition(newBlock, 'start')
        return true
      })
    },
  },
  inputRules: [
    {
      find: /^```(.*?)\s$/,
      replace: ({ match }: any) => ({
        type: 'codeBlock',
        props: { language: match[1].trim() },
        content: [],
      }),
    },
  ],
})

/** The language handed to Shiki for a code block.
 *
 *  While the AI writes, the fence is still streaming (` ```py ` → ` ```pyth ` …),
 *  so the block falls back to plain text: Shiki is not asked to load a
 *  half-typed language (which would fetch the wrong grammar and record it as
 *  permanently unsupported — see shikiHighlighter.ts). The language is parsed
 *  again as soon as the block itself changes: picking one in the header writes
 *  the prop, and either that or an edit invalidates the highlighter's cache for
 *  the node. */
const codeBlockHighlightLanguage = (block: any) => _previewRenderingPaused
  ? ''
  : parseCodeBlockInfo(block.props.language).language

/** React codeBlock spec — same node type, parse, serialize, and shortcuts as
 *  the default vanilla spec, but with the AI-writing freeze applied (see
 *  StableCodeBlockPreview). */
const codeBlockSpec = createReactBlockSpec(createCodeBlockConfig, {
  meta: { code: true, defining: true, isolating: false, highlight: codeBlockHighlightLanguage },
  parse: parsePreCode,
  parseContent: (opts: any) => parsePreCodeContent(opts, 'codeBlock'),
  render: StableCodeBlockPreview,
  toExternalHTML: (props) => {
    const info: string = props.block.props.language ?? ''
    const { language } = parseCodeBlockInfo(info)
    return createElement('pre', null, createElement('code', {
      className: language ? `language-${language}` : undefined,
      'data-language': info || undefined,
      ref: props.contentRef,
    }))
  },
}, [codeBlockShortcuts])

/** Base BlockNote schema with heading levels 1-5. */
let _schema: any = null
export const getSchema = () => {
  if (!_schema) _schema = BlockNoteSchema.create({
    blockSpecs: {
      ...defaultBlockSpecs,
      heading: createHeadingBlockSpec({ levels: [1, 2, 3, 4, 5], allowToggleHeadings: false }),
      codeBlock: codeBlockSpec(),
      mathBlock: mathBlockSpec(),
      diagram: diagramSpec(),
    },
    inlineContentSpecs: {
      ...defaultInlineContentSpecs,
      math: mathInlineSpec,
    },
  })
  return _schema
}

/** Visual indicator for `[[wikilink]]` text: accent + underline + pointer so
 *  Cmd+Click navigation is discoverable. ProseMirror decorations only — the
 *  stored content stays literal `[[Title]]` (markdown round-trip untouched).
 *
 *  The full-doc regex scan runs on EVERY transaction — during AI typing that
 *  is one O(document) scan per 50ms batch. WysiwygEditor pauses it while the
 *  AI writes (setWikilinkStylerPaused); the underline returns on unpause via
 *  the unpause transaction (decorations only recompute on state change). */
let _decosPaused = false
export const setWikilinkStylerPaused = (paused: boolean) => { _decosPaused = paused }
export const wikilinkStyler = createExtension({
  key: 'wikilinkStyler',
  prosemirrorPlugins: [
    new Plugin({
      props: {
        decorations(state) {
          if (_decosPaused) {
            // Skip the O(document) scan while streaming — no underline during
            // AI typing is a fine trade for not rescanning per 50ms batch.
            return DecorationSet.empty
          }
          const decos: Decoration[] = []
          const re = /\[\[([^\]]+)\]\]/g
          state.doc.descendants((node, pos) => {
            if (node.isText) {
              const text = node.text || ''
              let m: RegExpExecArray | null
              while ((m = re.exec(text)) !== null) {
                decos.push(Decoration.inline(pos + m.index, pos + m.index + m[0].length, {
                  'data-wikilink': '1',
                  style: 'color: var(--color-accent); text-decoration: underline; cursor: pointer;',
                }))
              }
            }
            return true
          })
          return DecorationSet.create(state.doc, decos)
        },
        /** Cmd/Ctrl+Click on a `[[wikilink]]` opens the note. Must run here
         *  (ProseMirror prop) and return true: PM core's `selectNodeModifier`
         *  (metaKey on mac) would otherwise select the whole paragraph block
         *  on mouseup — conflicting with navigation and crashing the editor
         *  when the document is swapped mid node-selection. */
        handleClick(view, pos, event) {
          if (!(event.metaKey || event.ctrlKey)) return false
          const t = event.target as HTMLElement | null
          if (!(t?.tagName === 'SPAN' && t.getAttribute('data-wikilink') === '1')) return false
          const $pos = view.state.doc.resolve(pos)
          const title = findWikilinkAt($pos.parent.textContent || '', pos - $pos.start())
          if (title) {
            openWikilink(title)
            return true // consumed — PM skips its own selection entirely
          }
          return false
        },
      },
    }),
  ],
})
