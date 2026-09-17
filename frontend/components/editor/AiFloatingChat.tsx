import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ListFilterPlus, ArrowUp, Check, RotateCcw, Loader2, X, FileText, Folder } from 'lucide-react'
import type { AiMenuState } from '../../utils/aiExtension'
import { getDefaultAIMenuItems } from '../../utils/aiMenu'
import { useEditorStore } from '../../stores/editor'
import { useVaultStore } from '../../stores/vault'
import { useAiChat } from '../../stores/aiChat'
import { useAiSettings } from '../../stores/aiSettings'
import { useAiThreads } from '../../stores/aiThreads'
import { toast } from 'sonner'
import { hasAISelection, openAIMenuAtAnchor, restoreAISelection } from '../../utils/aiBlocks'
import { invoke } from '../../lib/ipc'
import { parseMentions } from '../../utils/aiMentions'

type TreeEntry = { path: string; name: string; type: string }

/** Dropdown cap — the picker is a filter over the vault, not a browser. */
const MENTION_LIST_LIMIT = 40
/** Concurrent list_tree calls. Serial recursion made the dropdown wait for the
 *  whole vault; unbounded fan-out would flood the IPC. */
const MENTION_LIST_CONCURRENCY = 6

/** Stable option ids for aria-activedescendant (vault paths are not valid ids). */
const optionId = (position: number) => `mention-option-${position}`

/** Folder part of a vault path (`docs/notes` for `docs/notes/guide.md`), empty
 *  at the vault root. */
const parentOf = (path: string) => {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

/** Recursive vault listing for the mention picker.
 *
 *  A folder that cannot be listed (deleted/renamed mid-walk, permissions) only
 *  skips its own subtree — the previous implementation rejected the whole walk
 *  and blanked the dropdown, which is what made files "disappear" from the
 *  suggestions. Returns the count so the UI can say so instead of pretending
 *  the vault is empty. */
async function listVaultEntries(): Promise<{ entries: TreeEntry[]; unreadable: number }> {
  const entries: TreeEntry[] = []
  let unreadable = 0
  let queue = ['']
  while (queue.length > 0) {
    const batch = queue.splice(0, MENTION_LIST_CONCURRENCY)
    const results = await Promise.all(batch.map(async (subpath): Promise<{ subpath: string; children: TreeEntry[] } | null> => {
      try {
        const value = await invoke<string>('list_tree', { subpath })
        const children = (typeof value === 'string' ? JSON.parse(value) : value) as TreeEntry[]
        return { subpath, children: Array.isArray(children) ? children : [] }
      } catch {
        unreadable += 1
        return null
      }
    }))
    const next: string[] = []
    for (const result of results) {
      if (!result) continue
      for (const child of result.children) {
        const path = result.subpath ? `${result.subpath}/${child.name}` : child.name
        // Folders stay selectable: a folder mention reads it recursively.
        if (child.type === '1') { entries.push({ ...child, path }); next.push(path) }
        else if (/\.(md|mdx)$/i.test(child.name)) entries.push({ ...child, path })
      }
    }
    queue = queue.concat(next)
  }
  /** Folders first (as in the file tree), then files, each alphabetical. */
  entries.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === '1' ? -1 : 1))
  return { entries, unreadable }
}

export default function AiFloatingChat() {
  const editor = useEditorStore((s) => s.blockEditor)
  const activeTab = useEditorStore((s) => s.activeTab)
  const vaultPath = useVaultStore((s) => s.vaultPath)
  const { selectionPromptOpen, expanded, input, focusRequest, mentionNotice, setExpanded, setInput, setSelectionPromptOpen, setMentionNotice } = useAiChat()
  const provider = useAiSettings((s) => s.provider)
  const savedProviders = useAiSettings((s) => s.savedProviders)
  const aiConfigured = !!provider && savedProviders.includes(provider)
  const [picker, setPicker] = useState<{ start: number; end: number; query: string } | null>(null)
  const [index, setIndex] = useState<{ vault: string; entries: TreeEntry[]; unreadable: number } | null>(null)
  const [activeOption, setActiveOption] = useState(0)
  const indexRequest = useRef(0)
  const activeOptionRef = useRef<HTMLButtonElement>(null)
  const pickerOpen = picker !== null
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const ai = editor?.getExtension?.('ai') ?? null

  const aiMenu: AiMenuState = useSyncExternalStore(
    useCallback((cb) => (ai ? ai.store.subscribe(cb as any) : () => {}), [ai]),
    () => (ai ? ai.store.state.aiMenuState : 'closed'),
    () => (ai ? ai.store.state.aiMenuState : 'closed'),
  )
  const isOpen = aiMenu !== 'closed'
  const status = isOpen ? aiMenu.status : 'closed'
  const hasInput = input.trim().length > 0
  const canPrompt = status === 'closed' || status === 'user-input' || status === 'user-reviewing'
  const canTogglePrompts = status === 'closed' || status === 'user-input'
  const promptEnabled = aiConfigured && canPrompt

  useEffect(() => { if (focusRequest) inputRef.current?.focus({ preventScroll: true }) }, [focusRequest])
  useEffect(() => {
    if (!focusRequest) return
    const el = inputRef.current
    if (!el) return
    el.setSelectionRange(el.value.length, el.value.length)
    el.scrollTop = el.scrollHeight
  }, [focusRequest])

  const close = useCallback(() => {
    setPicker(null)
    if (!ai || aiMenu === 'closed') { setExpanded(false); return }
    if (aiMenu.status === 'thinking' || aiMenu.status === 'ai-writing') ai.abort?.('dismissed by user').catch(() => {})
    else if (aiMenu.status === 'user-reviewing' || aiMenu.status === 'error') ai.rejectChanges()
    else ai.closeAIMenu()
    setExpanded(false)
  }, [ai, aiMenu, setExpanded])

  useEffect(() => {
    if (!expanded) return
    const dismissOutside = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) { setPicker(null); close() }
    }
    window.addEventListener('mousedown', dismissOutside, true)
    return () => window.removeEventListener('mousedown', dismissOutside, true)
  }, [expanded, close])

  useEffect(() => {
    if (!expanded && !isOpen && !picker) return
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (picker) { event.preventDefault(); event.stopPropagation(); setPicker(null); return }
      event.preventDefault(); close()
    }
    window.addEventListener('keydown', dismissOnEscape, true)
    return () => window.removeEventListener('keydown', dismissOnEscape, true)
  }, [expanded, isOpen, close, picker])

  /** Grow the prompt textarea with its content (multi-line prompts must stay
   *  readable) and shrink back when cleared. CSS max-h caps the growth; longer
   *  prompts scroll inside the box.
   *
   *  caniuse audit (app minimum target = Safari 15): scrollHeight + style
   *  height + resize-none + overflow-y-auto are all baseline (~2015), so no
   *  gating needed. Deliberately NOT using `field-sizing: content` — Chrome
   *  123+ / Safari 18.4+ only, which would silently break the auto-grow on
   *  Safari 15. */
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = el.scrollHeight + 'px'
  }, [input])

  /** Walk the vault once per mention session, not once per keystroke: the
   *  previous version re-listed every folder on each character, so a large
   *  vault showed "No matching files or folders" for seconds while the user
   *  typed. Filtering is now pure in-memory. */
  useEffect(() => {
    if (!pickerOpen) return
    const vault = vaultPath ?? ''
    const requestId = ++indexRequest.current
    let active = true
    listVaultEntries().then((result) => {
      if (!active || indexRequest.current !== requestId) return
      if (import.meta.env.DEV) console.debug('[mention] vault index', { files: result.entries.length, unreadable: result.unreadable })
      setIndex({ vault, ...result })
    })
    return () => { active = false }
  }, [pickerOpen, vaultPath])

  /** Loading is derived, not stored: an index from a previous vault must not be
   *  shown (or filtered) as if it belonged to the current one. */
  const currentIndex = index && index.vault === (vaultPath ?? '') ? index : null
  const indexLoading = pickerOpen && !currentIndex

  /** Same basename in two folders renders as two identical rows, so those rows
   *  name their folder. Counting runs over the whole match set rather than the
   *  visible slice, so a truncated list cannot silently hide a duplicate. The
   *  inserted token is the full path either way. */
  const { visibleEntries, ambiguousNames } = useMemo(() => {
    const query = String(picker?.query ?? '').toLowerCase()
    const all = currentIndex?.entries ?? []
    const matched = query
      ? all.filter((entry) => entry.name.toLowerCase().includes(query) || entry.path.toLowerCase().includes(query))
      : all
    const counts = new Map<string, number>()
    for (const entry of matched) {
      const name = entry.name.toLowerCase()
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    const ambiguous = new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name))
    return { visibleEntries: matched.slice(0, MENTION_LIST_LIMIT), ambiguousNames: ambiguous }
  }, [currentIndex, picker?.query])

  const activeIndex = Math.min(activeOption, Math.max(visibleEntries.length - 1, 0))
  const activeEntry = visibleEntries[activeIndex]

  useEffect(() => { activeOptionRef.current?.scrollIntoView({ block: 'nearest' }) }, [activeEntry?.path, pickerOpen])

  const onInputChange = (value: string, caret: number) => {
    setInput(value)
    const before = value.slice(0, caret)
    const match = before.match(/(?:^|\s)@([A-Za-z0-9._/-]*)$/)
    if (match) {
      const start = caret - match[1].length - 1
      setPicker({ start, end: caret, query: match[1] })
      setActiveOption(0)
    } else setPicker(null)
  }

  const insertMention = (entry: TreeEntry) => {
    const folder = entry.type === '1'
    const token = entry.path + (folder ? '/' : '')
    const quoted = /\s/.test(token) ? `@"${token}"` : `@${token}`
    const current = inputRef.current
    const start = picker?.start ?? input.length
    const end = picker?.end ?? input.length
    const next = input.slice(0, start) + quoted + ' ' + input.slice(end)
    setInput(next)
    setPicker(null)
    requestAnimationFrame(() => {
      current?.focus()
      current?.setSelectionRange(start + quoted.length + 1, start + quoted.length + 1)
    })
  }

  const removeMention = (mention: { start: number; end: number }) => {
    const before = input.slice(0, mention.start)
    const after = input.slice(mention.end)
    const next = before.replace(/\s+$/, '') + (before && after ? ' ' : '') + after.replace(/^\s+/, '')
    setInput(next)
  }

  const mentions = useMemo(() => parseMentions(input).mentions, [input])
  const items = useMemo(() => {
    if (status !== 'user-input' || selectionPromptOpen) return []
    return getDefaultAIMenuItems(editor, 'user-input').map((item) => ({ ...item, onItemClick: () => { setExpanded(false); item.onItemClick((prompt) => useAiChat.getState().focusInput(prompt)) } }))
  }, [status, editor, setExpanded, selectionPromptOpen])

  if (!ai) return null

  const submit = () => {
    const prompt = input.trim()
    if (!prompt || !aiConfigured) return
    setExpanded(false); setPicker(null); setSelectionPromptOpen(false)
    // The previous retrieval summary must not describe this new request; the
    // transport publishes the fresh one once the mentions are resolved.
    setMentionNotice(null)
    if (!isOpen && !openAIMenuAtAnchor(editor)) return
    const useSelection = hasAISelection(editor)
    if (useSelection && !restoreAISelection(editor)) { toast.error('Text selection is no longer available. Select the text again.'); ai.closeAIMenu(); return }
    ai.invokeAI({ userPrompt: prompt, useSelection })
    setInput('')
  }

  const settleThreadStatus = (status: string) => {
    const path = activeTab ?? ''
    if (!path) return
    const thread = useAiThreads.getState().threads.find((item) => item.filePath === path && (item.vaultPath ?? '') === (vaultPath ?? ''))
    if (thread) useAiThreads.getState().updateLatestAssistantStatus(thread.id, status)
  }
  const accept = () => { setExpanded(false); settleThreadStatus('Document accepted by editor.'); ai.acceptChanges() }
  const revert = () => { setExpanded(false); settleThreadStatus('Document reverted by editor.'); ai.rejectChanges() }

  const promptInput = (
    <>
      {mentions.length > 0 && <div className="flex flex-wrap gap-1 px-3 pt-2">{mentions.map((mention) => <span key={`${mention.start}:${mention.end}`} className="flex items-center gap-1 rounded-full bg-surface-active px-2 py-1 text-[11px] text-foreground-secondary"><FileText size={11} />{mention.token}<button aria-label={`Remove @${mention.token}`} className="p-1" onClick={() => removeMention(mention)}><X size={11} /></button></span>)}</div>}
      {mentionNotice && <div className="px-3 pt-1 text-[10px] text-muted">{mentionNotice}</div>}
      {picker && <div role="listbox" aria-label="Mention files and folders" aria-activedescendant={activeEntry ? optionId(activeIndex) : undefined} className="absolute bottom-full left-0 z-50 mb-2 max-h-56 w-full overflow-auto rounded-lg border border-border bg-surface p-1 shadow-lg">{visibleEntries.length ? visibleEntries.map((entry, position) => <button key={entry.path} ref={entry === activeEntry ? activeOptionRef : undefined} id={optionId(position)} role="option" aria-selected={entry === activeEntry} onMouseDown={(event) => event.preventDefault()} onClick={() => insertMention(entry)} className="flex min-h-10 w-full items-center gap-2 rounded px-3 text-left text-xs hover:bg-surface-active">{entry.type === '1' ? <Folder size={14} /> : <FileText size={14} />}{entry.name}{ambiguousNames.has(entry.name.toLowerCase()) && parentOf(entry.path) && <span className="truncate text-[10px] text-muted">{parentOf(entry.path)}</span>}{entry.type === '1' && <span className="ml-auto text-muted">recursive</span>}</button>) : <div className="px-3 py-2 text-xs text-muted">{currentIndex && currentIndex.unreadable > 0 && currentIndex.entries.length === 0 ? 'Could not read the vault — try again' : indexLoading ? 'Loading vault…' : 'No matching files or folders'}</div>}{currentIndex && currentIndex.unreadable > 0 && visibleEntries.length > 0 && <div className="px-3 py-1 text-[10px] text-muted">{currentIndex.unreadable} folder{currentIndex.unreadable === 1 ? '' : 's'} could not be read</div>}</div>}
      <div className="flex w-full min-w-0 items-end gap-2 p-2">
        <textarea ref={inputRef} value={input} onChange={(event) => onInputChange(event.target.value, event.target.selectionStart)} onKeyDown={(event) => {
          if (picker && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); setActiveOption((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + visibleEntries.length) % Math.max(visibleEntries.length, 1)); return }
          if (picker && event.key === 'Enter' && activeEntry) { event.preventDefault(); insertMention(activeEntry); return }
          if (picker && event.key === 'Tab' && activeEntry) { event.preventDefault(); insertMention(activeEntry); return }
          if (event.key === 'Backspace' && !input && mentions.length) { event.preventDefault(); removeMention(mentions[mentions.length - 1]); return }
          if (event.key === 'Enter' && !event.shiftKey && hasInput && promptEnabled) { event.preventDefault(); submit() }
        }} rows={1} aria-label="AI prompt" disabled={!promptEnabled} placeholder={aiConfigured ? 'Message the Agent, @ to include context' : 'Configure API key in Settings (⌘,)'} title={aiConfigured ? 'Enter to send · Shift+Enter for new line' : 'Configure an API key in Settings (⌘,)'} className="min-h-7 max-h-30 min-w-0 flex-1 resize-none overflow-y-auto border-none bg-transparent px-1.5 py-1.5 text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-60" />
        {(hasInput || !selectionPromptOpen) && <button onClick={hasInput ? submit : () => useAiChat.getState().togglePrompts()} onMouseDown={(event) => event.preventDefault()} disabled={!aiConfigured || (hasInput ? !canPrompt : !canTogglePrompts)} aria-label={hasInput ? 'Send prompt' : expanded ? 'Hide AI prompts' : 'Show AI prompts'} aria-expanded={!hasInput && canTogglePrompts ? expanded : undefined} title={hasInput ? 'Send prompt (Enter)' : 'AI prompts'} className={'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border-none cursor-pointer disabled:cursor-not-allowed disabled:opacity-35 ' + (hasInput ? 'bg-accent text-on-accent hover:bg-accent-hover' : 'bg-transparent text-foreground hover:bg-surface-active')}>{hasInput ? <ArrowUp size={16} /> : <ListFilterPlus size={16} />}</button>}
      </div>
    </>
  )

  const statusBar = status === 'thinking' || status === 'ai-writing' ? <div className="ai-chat-status flex items-center gap-2 border-b border-border-subtle px-3 py-2"><Loader2 size={13} className="animate-spin text-accent" /><span className="text-xs text-foreground-secondary">{status === 'thinking' ? 'Thinking…' : 'Writing…'}</span><button onClick={() => { setExpanded(false); ai.abort?.('stopped by user').catch(() => {}) }} className="ml-auto cursor-pointer rounded border border-border-subtle bg-surface-active px-2 py-1 text-[11px] text-foreground-secondary hover:text-foreground">Stop</button></div> : status === 'user-reviewing' ? <div className="ai-chat-status flex items-center gap-2 border-b border-border-subtle px-3 py-2"><span className="text-xs text-foreground-secondary">Review the changes</span><div className="ml-auto flex items-center gap-2"><button onClick={revert} onMouseDown={(event) => event.preventDefault()} className="cursor-pointer rounded border border-border-subtle bg-surface-active px-2.5 py-1 text-[11px] text-foreground-secondary hover:text-foreground">Revert</button><button onClick={accept} onMouseDown={(event) => event.preventDefault()} className="flex cursor-pointer items-center gap-1 rounded border-none bg-accent px-2.5 py-1 text-[11px] text-on-accent hover:bg-accent-hover"><Check size={11} />Accept</button></div></div> : status === 'error' ? <div className="ai-chat-status border-b border-border-subtle px-3 py-2"><div className="wrap-break-word text-[11px] text-danger">{typeof aiMenu !== 'string' && aiMenu.error ? String(aiMenu.error?.message ?? aiMenu.error) : 'Something went wrong'}</div><div className="mt-2 flex justify-end gap-2"><button onClick={() => { setExpanded(false); ai.rejectChanges() }} className="cursor-pointer rounded border border-border-subtle bg-surface-active px-2.5 py-1 text-[11px] text-foreground-secondary hover:text-foreground">Cancel</button><button onClick={() => { setExpanded(false); ai.retry()?.catch(() => {}) }} className="flex cursor-pointer items-center gap-1 rounded border-none bg-accent px-2.5 py-1 text-[11px] text-on-accent hover:bg-accent-hover"><RotateCcw size={11} />Retry</button></div></div> : null

  return <div ref={rootRef} className="editor-ai-floating pointer-events-auto absolute bottom-5 left-1/2 z-50 flex -translate-x-1/2 flex-col items-end gap-2">
    {aiConfigured && !selectionPromptOpen && status === 'user-input' && expanded && !hasInput && items.length > 0 && <div className="relative z-30 flex flex-col items-end gap-2">{items.map((item) => <button key={item.key} onClick={item.onItemClick} onMouseDown={(event) => event.preventDefault()} className="ui-popover relative flex min-h-10 min-w-37 items-center gap-3 px-4 py-2.5 text-left text-xs font-medium text-foreground cursor-pointer"><span className="flex w-5 shrink-0 items-center justify-center text-accent">{item.icon}</span>{item.title}</button>)}</div>}
    <div className="ai-chat-surface relative flex w-full flex-col overflow-visible rounded-xl border border-border transition-colors focus-within:border-accent">{statusBar}{promptInput}</div>
  </div>
}
