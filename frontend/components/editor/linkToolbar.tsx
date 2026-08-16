/** Link toolbar overrides + note linker — vault-relative links preserve as-typed URLs
 *  (BlockNote's default https-forces them, mangling ./folder.md) and the link
 *  popover merges a vault-note search into one bubble-menu icon. */
import { useEffect, useState } from 'react'
import { useBlockNoteEditor, useComponentsContext, useExtension, useEditorState, DeleteLinkButton, FormattingToolbar, getFormattingToolbarItems, type LinkToolbarProps } from '@blocknote/react'
import { LinkToolbarExtension, FormattingToolbarExtension, ShowSelectionExtension } from '@blocknote/core/extensions'
import { AIToolbarButton } from '@blocknote/xl-ai'
import { Link2, Type, ExternalLink } from 'lucide-react'
import { useEditorStore } from '../../stores/editor'
import { invoke } from '../../lib/ipc'

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
function LinkUrlForm({ url, text, range, showTextField, onSubmitted }: {
  url: string
  text: string
  range: { from: number; to: number }
  showTextField?: boolean
  onSubmitted: () => void
}) {
  const Components = useComponentsContext()!
  const { editLink } = useExtension(LinkToolbarExtension)
  const [currentUrl, setCurrentUrl] = useState(url)
  const [currentText, setCurrentText] = useState(text)
  useEffect(() => { setCurrentUrl(url); setCurrentText(text) }, [url, text])
  const submit = () => {
    editLink(currentUrl.trim(), currentText, range.from)
    onSubmitted()
  }
  return (
    <Components.Generic.Form.Root>
      <Components.Generic.Form.TextInput className="bn-text-input" name="url" icon={<Link2 size={14} />} autoFocus
        placeholder="https://… or ./folder.md" value={currentUrl}
        onChange={e => setCurrentUrl(e.currentTarget.value)}
        onSubmit={submit}
        onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }} />
      {showTextField !== false && (
        <Components.Generic.Form.TextInput className="bn-text-input" name="title" icon={<Type size={14} />}
          placeholder="Text" value={currentText}
          onChange={e => setCurrentText(e.currentTarget.value)}
          onSubmit={submit}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }} />
      )}
    </Components.Generic.Form.Root>
  )
}

/** LinkToolbar "Edit" — preserves the URL as-typed (vault-relative links). */
function EditLinkButtonPreserveUrl({ url, text, range, setToolbarOpen, setToolbarPositionFrozen }: Pick<LinkToolbarProps, 'url' | 'text' | 'range' | 'setToolbarOpen' | 'setToolbarPositionFrozen'>) {
  const Components = useComponentsContext()!
  return (
    <Components.Generic.Popover.Root onOpenChange={setToolbarPositionFrozen}>
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
  useEffect(() => { setShowPopover(false) }, [state])
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
    <Components.Generic.Popover.Root open={showPopover} onOpenChange={setShowPopover}>
      <Components.Generic.Popover.Trigger>
        <Components.FormattingToolbar.Button className="bn-button" label="Link" mainTooltip="Link"
          secondaryTooltip="⌘K" icon={<Link2 size={14} />}
          onClick={() => setShowPopover(o => !o)} />
      </Components.Generic.Popover.Trigger>
      <Components.Generic.Popover.Content className="bn-popover-content bn-form-popover w-[300px]" variant="form-popover">
        <LinkUrlForm url={state.url} text={state.text} range={state.range} showTextField={false}
          onSubmitted={() => { setShowPopover(false); formattingToolbar.store.setState(false) }} />
        <NoteLinkSearch onPick={(title) => {
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

/** Formatting toolbar (bubble menu) with the xl-ai button — shows the AI text prompt when text is selected. */
export const FormattingToolbarWithAI = () => (
  <FormattingToolbar>
    {getFormattingToolbarItems().filter(el => (el as any).key !== 'createLinkButton')}
    <CreateLinkButtonPreserveUrl />
    <AIToolbarButton />
  </FormattingToolbar>
)

/** "Link a note" — search vault notes (name + content via wiki_suggest) and
 *  pick → caller inserts a `[[wikilink]]`. Lives inside the merged link popover
 *  (one bubble-menu icon), not a separate button. */
function NoteLinkSearch({ onPick }: { onPick: (title: string) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ path: string; title: string }[]>([])
  const [selected, setSelected] = useState(0)

  useEffect(() => {
    if (!query.trim()) { setResults([]); return }
    const t = setTimeout(() => {
      invoke<string>('wiki_suggest', { query: query.trim() }).then(s => {
        try { setResults(JSON.parse(s)); setSelected(0) } catch {}
      }).catch(() => {})
    }, 150)
    return () => clearTimeout(t)
  }, [query])

  return (
    <div className="border-t border-border-subtle px-3 py-2">
      <div className="text-[10px] text-muted uppercase tracking-wider mb-1">or link a vault note</div>
      <input type="text" value={query} onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && results[selected]) { e.preventDefault(); onPick(results[selected].title) }
          if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(i => Math.min(i + 1, results.length - 1)) }
          if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(i => Math.max(i - 1, 0)) }
        }}
        placeholder="Search notes to link…"
        className="w-full bg-transparent border-b border-border px-1 py-1 text-sm text-foreground outline-none" />
      <div className="max-h-[160px] overflow-y-auto mt-1">
        {results.length === 0 && query && <div className="px-1 py-1 text-xs text-muted">No notes found</div>}
        {results.map((r, i) => (
          <div key={r.path} onClick={() => onPick(r.title)} onMouseEnter={() => setSelected(i)}
            className={'px-1 py-1 text-sm cursor-pointer rounded ' + (i === selected ? 'bg-surface-active text-foreground' : 'text-foreground-secondary')}>
            {r.title}
          </div>
        ))}
      </div>
    </div>
  )
}
