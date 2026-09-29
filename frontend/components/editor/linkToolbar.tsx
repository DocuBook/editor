import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useBlockNoteEditor, useComponentsContext, useExtension, useEditorState, ComponentsContext, useUIMode, DeleteLinkButton, FormattingToolbar, getFormattingToolbarItems, blockTypeSelectItems, TextAlignButton, NestBlockButton, UnnestBlockButton, ScreenReaderOnlySubmit, usePortalElement, type Components, type LinkToolbarProps } from '@blocknote/react'
import { LinkToolbarExtension, FormattingToolbarExtension, ShowSelectionExtension } from '@blocknote/core/extensions'
import { getDefaultAIMenuItems, getAIDictionary } from '../../utils/aiMenu'
import { Link2, Type, ExternalLink, Sparkles } from 'lucide-react'
import { useEditorStore } from '../../stores/editor'
import { useAiChat } from '../../stores/aiChat'
import { captureAISelection, openAIMenuAtAnchor, restoreAISelection } from '../../utils/aiBlocks'
import { looksLikeLink, resolveLinkInput } from '../../utils/linkInput'
import { invoke } from '../../lib/ipc'
import { toast } from 'sonner'
import { FormattingToolbarPopover } from './FormattingToolbarPopover'
import { InsertBlockButton } from './InsertBlockButton'
import { MoveBlockDownButton, MoveBlockUpButton } from './MoveBlockButtons'

/** Open an external URL: native uses the system opener (tauri-plugin-opener →
 *  macOS `open` → default browser); web falls back to window.open. Same user
 *  behavior on both runtimes (ADR D10 parity). */
async function openExternal(url: string) {
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
  } catch {
    window.open(url, '_blank')
  }
}

/** Shared link URL/text form — submits AS-TYPED (no https:// forcing).
 *  BlockNote's default EditLinkMenuItems.validateUrl prepends
 *  DEFAULT_LINK_PROTOCOL ("https") to any URL without a known scheme, which
 *  mangles vault-relative links: "./folder.md" → "https://./folder.md".
 *  Vault links must round-trip verbatim; bare web domains pasted into the
 *  editor are still https-ified by BlockNote's pasteHandler, so the form
 *  never needs to force a protocol. */
function LinkUrlForm({ url, text, range, onSubmitted }: {
  url: string
  text: string
  range: { from: number; to: number }
  onSubmitted: () => void
}) {
  const Components = useComponentsContext()!
  const { editLink } = useExtension(LinkToolbarExtension)
  const [currentUrl, setCurrentUrl] = useState(url)
  const [currentText, setCurrentText] = useState(text)
  /* oxlint-disable react/set-state-in-effect -- re-syncs form fields when the link target changes */
  useEffect(() => { setCurrentUrl(url); setCurrentText(text) }, [url, text])
  /* oxlint-enable react/set-state-in-effect */
  const submit = () => {
    editLink(currentUrl.trim(), currentText, range.from)
    onSubmitted()
  }
  /* 0.55 commits popover forms through the form's native submit instead of an
     Enter key handler — IMEs commit through submit without dispatching a key
     event. */
  return (
    <Components.Generic.Form.Root onSubmit={submit} submitButton={<ScreenReaderOnlySubmit />}>
      <Components.Generic.Form.TextInput className="bn-text-input" name="url" icon={<Link2 size={14} />} autoFocus
        placeholder="Paste URL or vault path…" value={currentUrl}
        onChange={e => setCurrentUrl(e.currentTarget.value)} />
      <Components.Generic.Form.TextInput className="bn-text-input" name="title" icon={<Type size={14} />}
        placeholder="Text" value={currentText}
        onChange={e => setCurrentText(e.currentTarget.value)} />
    </Components.Generic.Form.Root>
  )
}

/** LinkToolbar "Edit" — preserves the URL as-typed (vault-relative links). */
function EditLinkButtonPreserveUrl({ url, text, range, setToolbarOpen, setToolbarPositionFrozen }: Pick<LinkToolbarProps, 'url' | 'text' | 'range' | 'setToolbarOpen' | 'setToolbarPositionFrozen'>) {
  const Components = useComponentsContext()!
  const portalElement = usePortalElement()
  return (
    <Components.Generic.Popover.Root onOpenChange={setToolbarPositionFrozen} portalElement={portalElement}>
      <Components.Generic.Popover.Trigger>
        <Components.LinkToolbar.Button className="bn-button" mainTooltip="Edit link" isSelected={false}>
          Edit
        </Components.LinkToolbar.Button>
      </Components.Generic.Popover.Trigger>
      <Components.Generic.Popover.Content className="bn-popover-content bn-form-popover" variant="form-popover">
        <LinkUrlForm url={url} text={text} range={range}
          onSubmitted={() => { setToolbarOpen?.(false); setToolbarPositionFrozen?.(false) }} />
      </Components.Generic.Popover.Content>
    </Components.Generic.Popover.Root>
  )
}

/** Formatting-toolbar "Link" button (and Ctrl/Cmd+K) — same as-typed form.
 *  Replaces BlockNote's CreateLinkButton, which routes through the
 *  https-forcing EditLinkMenuItems. */
function CreateLinkButtonPreserveUrl() {
  const editor = useBlockNoteEditor<any, any, any>()
  const Components = useComponentsContext()!
  const portalElement = usePortalElement()
  const formattingToolbar = useExtension(FormattingToolbarExtension)
  const { showSelection } = useExtension(ShowSelectionExtension)
  const [showPopover, setShowPopover] = useState(false)
  /** Keep the text selection while the popover is open (correct link range). */
  useEffect(() => {
    showSelection(showPopover, "createLinkButton")
    return () => showSelection(false, "createLinkButton")
  }, [showPopover, showSelection])
  const state = useEditorState({
    editor,
    selector: ({ editor }) => {
      if (!editor.isEditable) return undefined
      return {
        url: editor.getSelectedLinkUrl() ?? '',
        text: editor.getSelectedText(),
        range: {
          from: editor.prosemirrorState.selection.from,
          to: editor.prosemirrorState.selection.to,
        },
      }
    },
  })
  /* oxlint-disable react/set-state-in-effect -- closes the popover when the selection changes */
  useEffect(() => { setShowPopover(false) }, [state])
  /* oxlint-enable react/set-state-in-effect */
  /** Ctrl/Cmd+K opens the link form (same shortcut as the default button). */
  useEffect(() => {
    const el = editor.domElement
    if (!el) return
    const cb = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); setShowPopover(true) }
    }
    el.addEventListener('keydown', cb)
    return () => el.removeEventListener('keydown', cb)
  }, [editor])
  if (state === undefined) return null
  return (
    <Components.Generic.Popover.Root open={showPopover} onOpenChange={setShowPopover} portalElement={portalElement}>
      <Components.Generic.Popover.Trigger>
        <Components.FormattingToolbar.Button className="bn-button" label="Link" mainTooltip="Link"
          secondaryTooltip="⌘K" icon={<Link2 size={14} />}
          onClick={() => setShowPopover(o => !o)} />
      </Components.Generic.Popover.Trigger>
      <Components.Generic.Popover.Content className="bn-popover-content bn-form-popover w-75" variant="form-popover">
        <LinkOrNoteForm url={state.url} text={state.text} range={state.range}
          onSubmitted={() => { setShowPopover(false); formattingToolbar.store.setState(false) }}
          onPickWikilink={(title) => {
            try { editor.insertInlineContent([{ type: 'text', text: `[[${title}]]`, styles: {} }] as any) } catch (e) { console.error('insert wikilink:', e) }
            setShowPopover(false); formattingToolbar.store.setState(false)
          }} />
      </Components.Generic.Popover.Content>
    </Components.Generic.Popover.Root>
  )
}

/** LinkToolbar override: "open" on a link pointing to a vault note (relative
 *  path, no scheme) opens the file in the app — not a browser tab. External
 *  URLs open via the system opener (native) / new tab (web).
 *  Edit preserves the URL as-typed (vault-relative links stay intact). */
export function WikiLinkToolbar({ url, text, range, setToolbarOpen, setToolbarPositionFrozen }: LinkToolbarProps) {
  const Components = useComponentsContext()!
  const openFile = useEditorStore(s => s.openFile)
  const activeTab = useEditorStore(s => s.activeTab)
  /** Vault link = no scheme and not protocol-relative (//host). Covers plain
   *  names, ./ and ../ (resolved against the ACTIVE file's folder — Obsidian
   *  semantics, NOT the vault root), and / (vault root). Absolute filesystem
   *  paths are excluded (no scheme check above rejects them; the server's
   *  safe_path also guards against any traversal). */
  const isVaultLink = !!url && !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('//')
  const open = () => {
    if (!url) return
    if (!isVaultLink) { openExternal(url); return }
    const target = url.split('#')[0].split('?')[0]   // strip #anchor / ?query
    if (!target) return                              // anchor-only link
    const curFile = activeTab ?? ''
    const curDir = curFile.includes('/') ? curFile.substring(0, curFile.lastIndexOf('/')) : ''
    const resolved = target.startsWith('/')
      ? target.replace(/^\/+/, '')                   // /path → vault root
      : (() => {
          const parts: string[] = []
          for (const seg of [curDir, target].filter(Boolean).join('/').split('/')) {
            if (seg === '..') parts.pop()
            else if (seg === '.' || seg === '') continue
            else parts.push(seg)
          }
          return parts.join('/')
        })()
    openFile(resolved, target.split('/').pop() || resolved)
  }
  return (
    <Components.LinkToolbar.Root className="bn-toolbar bn-link-toolbar">
      <Components.LinkToolbar.Button
        mainTooltip="Open"
        label="Open"
        isSelected={false}
        onClick={open}
        icon={<ExternalLink size={14} />}
      />
      <EditLinkButtonPreserveUrl url={url} text={text} range={range} setToolbarOpen={setToolbarOpen} setToolbarPositionFrozen={setToolbarPositionFrozen} />
      <DeleteLinkButton range={range} setToolbarOpen={setToolbarOpen} />
    </Components.LinkToolbar.Root>
  )
}

/** Formatting-toolbar AI button. Text-selection prompts stay beside their
 *  selection; cursor/node prompts keep using the floating composer. */
function AIToolbarButtonSafe() {
  const editor = useBlockNoteEditor<any, any, any>()
  const Components = useComponentsContext()!
  const portalElement = usePortalElement()
  const dict = getAIDictionary()
  const formattingToolbar = useExtension(FormattingToolbarExtension)
  const { showSelection } = useExtension(ShowSelectionExtension)
  const setSelectionPromptOpen = useAiChat((state) => state.setSelectionPromptOpen)
  const [showPopover, setShowPopover] = useState(false)

  useEffect(() => {
    showSelection(showPopover, 'aiToolbarPrompts')
    setSelectionPromptOpen(showPopover)
    return () => {
      showSelection(false, 'aiToolbarPrompts')
      setSelectionPromptOpen(false)
    }
  }, [showPopover, showSelection, setSelectionPromptOpen])

  if (!editor.isEditable) return null
  const items = getDefaultAIMenuItems(editor, 'user-input')
  const onClick = () => {
    let hasSelection = false
    try { hasSelection = !!editor.getSelection()?.blocks?.length } catch { /* use cursor mode */ }
    if (hasSelection) {
      captureAISelection(editor)
      setShowPopover((open) => !open)
      return
    }
    setSelectionPromptOpen(false)
    const blockId = openAIMenuAtAnchor(editor)
    if (!blockId) return
    formattingToolbar.store.setState(false)
    useAiChat.getState().setExpanded(true)
  }
  const selectPrompt = (item: (typeof items)[number]) => {
    if (!restoreAISelection(editor) || !openAIMenuAtAnchor(editor)) {
      toast.error('Text selection is no longer available. Select the text again.')
      setShowPopover(false)
      return
    }
    setShowPopover(false)
    setSelectionPromptOpen(false)
    formattingToolbar.store.setState(false)
    item.onItemClick((prompt) => useAiChat.getState().focusInput(prompt))
  }
  return (
    <Components.Generic.Popover.Root open={showPopover} onOpenChange={setShowPopover} portalElement={portalElement}>
      <Components.Generic.Popover.Trigger>
        <Components.Generic.Toolbar.Button
          className="bn-button"
          label={dict.formatting_toolbar.ai.tooltip}
          mainTooltip={dict.formatting_toolbar.ai.tooltip}
          icon={<Sparkles size={14} />}
          onClick={onClick}
        />
      </Components.Generic.Popover.Trigger>
      <Components.Generic.Popover.Content className="bn-popover-content p-1" variant="form-popover">
        <Components.SuggestionMenu.Root id="ai-toolbar-suggestion-menu">
          {items.map((item, index) => (
            <Components.SuggestionMenu.Item
              key={item.key}
              id={`ai-toolbar-suggestion-${index}`}
              className="bn-suggestion-menu-item bn-suggestion-menu-item-small"
              isSelected={false}
              item={item}
              onClick={() => selectPrompt(item)}
            />
          ))}
        </Components.SuggestionMenu.Root>
      </Components.Generic.Popover.Content>
    </Components.Generic.Popover.Root>
  )
}

/* Keys of the built-in formatting-toolbar items grouped into the compact panel.
   `getFormattingToolbarItems()` returns rendered ELEMENTS (e.g.
   `<BasicTextStyleButton basicTextStyle="underline" key="underlineStyleButton" />`),
   so `key` is the only handle on them — their props are already resolved, there is
   no onClick to re-dispatch. The panel therefore re-instantiates the public
   controls instead of reusing these elements. */
const GROUPED_KEYS = [
  'textAlignLeftButton',
  'textAlignCenterButton',
  'textAlignRightButton',
  'nestBlockButton',
  'unnestBlockButton',
] as string[]

/** Open formatting-toolbar menus/popovers, counted so CSS can suppress the
 *  editor caret while one is up (`data-toolbar-popup-open` in index.css). The
 *  counter outlives the toolbar's re-renders; the toolbar's unmount clears it,
 *  so a popup torn down with the editor (tab switch) cannot leave the caret
 *  hidden for the next one. */
let openToolbarPopups = 0
function trackToolbarPopup(open: boolean) {
  openToolbarPopups = Math.max(0, openToolbarPopups + (open ? 1 : -1))
  document.documentElement.toggleAttribute('data-toolbar-popup-open', openToolbarPopups > 0)
}
function clearToolbarPopups() {
  openToolbarPopups = 0
  document.documentElement.removeAttribute('data-toolbar-popup-open')
}

/** Wraps the row's buttons with toolbar-scoped adjustments — the components
 *  they open are patched, not the buttons themselves:
 *
 *  - `Generic.Menu.Root` prefers the `top` placement on the IME toolbar. The
 *    strip sits at the bottom edge of the visual viewport, so the default
 *    `bottom` anchor leaves its dropdown below the trigger — in the keyboard's
 *    band — where floating-ui measures 0px of room and hands the skin a
 *    NEGATIVE available height: an invalid `max-height` the browser drops. The
 *    dropdown is then neither clamped to the visible area nor flipped
 *    (Mantine falls back to the initial placement when nothing fits), so a
 *    tall one — the color menu — renders entirely behind the keyboard and no
 *    tap can reach it. Anchored to the top the clamp has a positive height to
 *    work with: the menu fits above the strip and scrolls there. Desktop has
 *    room below its bubble menu by construction and keeps upstream behavior.
 *  - Both `Menu.Root` and `Popover.Root` report their open state so the
 *    editor caret can be hidden while a popup is up: the popup opens over the
 *    caret's own line, and the caret can paint above it (reported from the IME
 *    toolbar). Focus, the selection and the soft keyboard are untouched, and
 *    the popup's own inputs — the link form, the AI prompt — keep their
 *    carets: only `.bn-editor` is suppressed.
 */
function ToolbarComponents({ children }: { children: ReactNode }) {
  const uiMode = useUIMode()
  const components = useComponentsContext()!
  const scoped = useMemo<Components>(() => {
    const Menu = components.Generic.Menu
    const Popover = components.Generic.Popover
    /* Only the mobile toolbar is affected — desktop keeps upstream behavior. */
    const track = (open: boolean) => { if (uiMode === 'mobile') trackToolbarPopup(open) }
    const TrackedMenuRoot: typeof Menu.Root = (props) => {
      const open = useRef(false)
      return <Menu.Root
        {...props}
        position={props.position ?? (uiMode === 'mobile' ? 'top' : undefined)}
        onOpenChange={(next) => {
          if (next !== open.current) { open.current = next; track(next) }
          props.onOpenChange?.(next)
        }} />
    }
    const TrackedPopoverRoot: typeof Popover.Root = (props) => {
      const open = useRef(false)
      return <Popover.Root
        {...props}
        onOpenChange={(next) => {
          if (next !== open.current) { open.current = next; track(next) }
          props.onOpenChange?.(next)
        }} />
    }
    return {
      ...components,
      Generic: {
        ...components.Generic,
        Menu: { ...Menu, Root: TrackedMenuRoot },
        Popover: { ...Popover, Root: TrackedPopoverRoot },
      },
    }
  }, [components, uiMode])
  return <ComponentsContext.Provider value={scoped}>{children}</ComponentsContext.Provider>
}

/** Formatting toolbar (bubble menu) with local AI button — shows text prompt when selected.
 *  `blockActions` carries the side menu's block actions for shells that have no
 *  side menu: the cursor-anchored `+`, and move up/down. WysiwygEditor sets it
 *  wherever `sideMenu` is off — both keyed to the same 640px `isDesktop` query,
 *  so no shell is left without an insert or reorder affordance. */
export const FormattingToolbarWithAI = ({ compact, blockActions }: { compact?: boolean; blockActions?: boolean } = {}) => {
  const editor = useBlockNoteEditor<any, any, any>()
  const blockTypes = blockTypeSelectItems(editor.dictionary)
    .filter(item => item.type !== 'heading' || (Number(item.props?.level) <= 5 && item.props?.isToggleable !== true))
    .map(item => item.type === 'heading'
      ? { ...item, props: Object.fromEntries(Object.entries(item.props ?? {}).filter(([key]) => key !== 'isToggleable')) }
      : item)

  const items = getFormattingToolbarItems(blockTypes).filter(el => (el as any).key !== 'createLinkButton')

  /* A popup torn down with the toolbar closes without an `onOpenChange`, which
     would leave the caret suppressed (see ToolbarComponents). */
  useEffect(() => clearToolbarPopups, [])

  // Both branches keep the upstream array order — only the split point moves.
  if (!compact) {
    return (
      <FormattingToolbar>
        <ToolbarComponents>
          {blockActions && (<><InsertBlockButton /><MoveBlockUpButton /><MoveBlockDownButton /></>)}
          {items}
          <CreateLinkButtonPreserveUrl />
          <AIToolbarButtonSafe />
        </ToolbarComponents>
      </FormattingToolbar>
    )
  }

  /* Compact layout: keep block type, the full inline-mark set (bold, italic,
     code, highlight, colour) and the app's own Link/AI actions on the row; move
     what otherwise gets clipped — underline, strikethrough, alignment, indent —
     into the overflow panel. Splitting on element KEYS (not on index) keeps the
     row correct if upstream reorders or adds items. The row takes no extra
     buttons at all — the side menu's block actions (insert, move up/down) stay
     in that panel, because a phone-width row cannot hold them without pushing
     its tail past the viewport edge. */
  const onRow = items.filter(el => !GROUPED_KEYS.includes((el as any).key))

  return (
    <FormattingToolbar>
      <ToolbarComponents>
        {onRow}
        <CreateLinkButtonPreserveUrl />
        <AIToolbarButtonSafe />
        <FormattingToolbarPopover label="More formatting">
          <TextAlignButton textAlignment="left" />
          <TextAlignButton textAlignment="center" />
          <TextAlignButton textAlignment="right" />
          {blockActions && <InsertBlockButton />}
          {blockActions && (<><MoveBlockUpButton /><MoveBlockDownButton /></>)}
          <NestBlockButton />
          <UnnestBlockButton />
        </FormattingToolbarPopover>
      </ToolbarComponents>
    </FormattingToolbar>
  )
}

/** Merged link form (formatting-toolbar "Link" + Ctrl/Cmd+K): ONE input for
 *  both link targets and vault notes — previously a URL form plus a second
 *  "link a vault note" search sat stacked in the same popover. Enter submits a
 *  link target through editLink AS-TYPED (no https:// forcing, vault-relative
 *  paths round-trip verbatim); a note-name query instead queries wiki_suggest
 *  (name + content) and inserts `[[title]]` on pick. The split lives in
 *  utils/linkInput so it is unit-testable. */
function LinkOrNoteForm({ url, text, range, onSubmitted, onPickWikilink }: {
  url: string
  text: string
  range: { from: number; to: number }
  onSubmitted: () => void
  onPickWikilink: (title: string) => void
}) {
  const Components = useComponentsContext()!
  const { editLink } = useExtension(LinkToolbarExtension)
  const [value, setValue] = useState(url)
  const [results, setResults] = useState<{ path: string; title: string }[]>([])
  const [selected, setSelected] = useState(0)
  const linkTarget = looksLikeLink(value.trim())
  /* oxlint-disable react/set-state-in-effect -- re-syncs the field when the link target changes */
  useEffect(() => { setValue(url) }, [url])
  /* oxlint-enable react/set-state-in-effect */
  /* oxlint-disable react/set-state-in-effect -- clears suggestions when the query is emptied */
  useEffect(() => {
    const q = value.trim()
    if (!q || linkTarget) { setResults([]); return }
    const t = setTimeout(() => {
      invoke<string>('wiki_suggest', { query: q }).then(s => {
        try { setResults(JSON.parse(s)); setSelected(0) } catch {}
      }).catch(() => {})
    }, 150)
    return () => clearTimeout(t)
  }, [value, linkTarget])
  /* oxlint-enable react/set-state-in-effect */
  const submit = () => {
    const action = resolveLinkInput(value, results, selected)
    if (!action) return
    if (action.kind === 'wikilink') { onPickWikilink(action.title); return }
    editLink(action.target, text, range.from)
    onSubmitted()
  }
  return (
    <Components.Generic.Form.Root onSubmit={submit} submitButton={<ScreenReaderOnlySubmit />}>
      <Components.Generic.Form.TextInput className="bn-text-input" name="url" icon={<Link2 size={14} />} autoFocus
        placeholder="Paste URL or type to suggest…" value={value}
        onChange={e => setValue(e.currentTarget.value)}
        onKeyDown={e => {
          /* Enter commits through the form's native submit (0.55); only the
             suggestion list navigation stays on the key handler. */
          if (e.nativeEvent.isComposing || linkTarget) return
          if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(i => Math.min(i + 1, results.length - 1)) }
          if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(i => Math.max(i - 1, 0)) }
        }} />
      {!linkTarget && (results.length > 0 || !!value.trim()) && (
        <div className="max-h-40 overflow-y-auto">
          {results.length === 0 && <div className="px-1 py-1 text-xs text-muted">No notes found — ↵ links as typed</div>}
          {results.map((r, i) => (
            <div key={r.path} onClick={() => onPickWikilink(r.title)} onMouseEnter={() => setSelected(i)}
              className={'px-1 py-1 text-sm cursor-pointer rounded ' + (i === selected ? 'bg-surface-active text-foreground' : 'text-foreground-secondary')}>
              {r.title}
            </div>
          ))}
        </div>
      )}
    </Components.Generic.Form.Root>
  )
}
