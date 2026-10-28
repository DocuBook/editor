import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { Zap, ArrowUp, Check, RotateCcw, Loader2, X, FileText, Folder, ChevronsUpDown, Command, CornerDownLeft } from 'lucide-react'
import type { AiMenuState } from '../../utils/aiExtension'
import { getDefaultAIMenuItems } from '../../utils/aiMenu'
import { useEditorStore } from '../../stores/editor'
import { useVaultStore } from '../../stores/vault'
import { useAiChat } from '../../stores/aiChat'
import { useAiSettings } from '../../stores/aiSettings'
import { toast } from 'sonner'
import { hasAISelection, openAIMenuAtAnchor, restoreAISelection } from '../../utils/aiBlocks'
import { mentionText, parseMentions } from '../../utils/aiMentions'
import { loadMentionIndex, type MentionEntry } from '../../utils/mentionIndex'
import { observeMobileToolbar } from '../../utils/mobileToolbar'
import { fetchProviderModels, type DiscoveredModel } from '../../utils/modelDiscovery'
import { PROVIDERS } from '../../data/providers'
import { CUSTOM_PROVIDER_ID } from '../../stores/aiSettings'
import { getAiConfig } from '../../utils/aiConfig'
import { ensureToolProbe } from '../../utils/aiProbe'
import { softKeyboardOnFocus } from '../../utils/softKeyboard'

type TreeEntry = MentionEntry

/** Dropdown cap — the picker is a filter over the vault, not a browser. */
const MENTION_LIST_LIMIT = 40
/** Scroll-direction fade: no hiding while the document is inside the top band,
 *  or a single tick of momentum scroll would blink the composer on every
 *  overscroll back to the top. */
const TOP_SHOW_THRESHOLD = 64
/** Minimum px per animation frame before a scroll direction counts — absorbs
 *  trackpad jitter and the tiny deltas of an inertial scroll winding down. */
const SCROLL_DIRECTION_TOLERANCE = 3
/** How recently a wheel/touch gesture must have reached the container for a
 *  scroll to count as the user's. Scroll position alone cannot say who scrolled:
 *  the browser scrolls the container on its own to reveal the caret when the
 *  soft keyboard opens (the shell is `dvh` behind `interactive-widget=resizes-content`)
 *  and while an IME composition advances — reported from a phone, where that
 *  reveal hid the composer with the user's hands off the screen. Long enough
 *  that a gesture's own scroll event (rAF-batched) still lands inside it, far
 *  shorter than a reveal that starts from a tap. Keyboard scrolling is
 *  deliberately not a gesture: caret-following scrolls are the same shape. */
const USER_SCROLL_WINDOW = 300
/** How long after a composition commits an Escape still counts as the IME's.
 *  Some engines cancel a candidate strip with an Escape they emit only after
 *  `compositionend`, so the key arrives with `isComposing` already false. Long
 *  enough to swallow that, far shorter than the pause before a user leaves. */
const POST_COMPOSITION_ESCAPE_MS = 250

/** Stable option ids for aria-activedescendant (vault paths are not valid ids). */
const optionId = (position: number) => `mention-option-${position}`

/** `aria-controls` target for the composer while the picker is open. */
const MENTION_LISTBOX_ID = 'mention-listbox'
/** Group header inside a stacked panel (a provider in the model picker, the
 *  prompt list's own title). */
const PANEL_HEADER_CLASS = 'px-2.5 pt-2 pb-1 text-[9px] font-semibold uppercase tracking-wide text-muted'

/** Group header of a provider in the model picker. Two providers can serve the
 *  same model id (OpenCode Go and DeepSeek both list `deepseek-v4-flash`), and
 *  the pick decides which provider is billed, so rows sit under their
 *  provider's header instead of carrying a badge each. */
const providerGroupLabel = (id: string) =>
  id === CUSTOM_PROVIDER_ID ? 'OpenAI Compatible' : PROVIDERS.find((item) => item.id === id)?.name || id

/** One provider's model list in the picker, as the provider reported it on
 *  this open. `error` falls back to the backend's default model. */
type ProviderModels = { status: 'loading' | 'ok' | 'error'; models: DiscoveredModel[] }

/** Folder part of a vault path (`docs/notes` for `docs/notes/guide.md`), empty
 *  at the vault root. */
const parentOf = (path: string) => {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

/** Picker row chrome, mirroring the search modal: the row Enter would pick takes
 *  the accent, so keyboard navigation is visible instead of a blind commit. The
 *  hover tint is only on unselected rows, or hovering would paint over the
 *  highlight and hide which row is armed. */
/** Text size of the composer's controls (buttons, the search box, the prompt
 *  box). Until Mantine's stylesheet moved into its own cascade layer, its
 *  unlayered `button, input, textarea { font: inherit }` beat every Tailwind
 *  class on them, so they all rendered at the inherited 14px (line-height 1.5)
 *  whatever their classes said — and that is the look the composer was
 *  designed and approved at (#366, #367). Now that classes apply, the size is
 *  spelled out instead of the never-applied 10–13px ones. No leading: the
 *  inherited 1.5 is exactly what rendered, where `text-sm`'s 20px would not be. */
const CONTROL_TEXT = 'text-[14px]'

/** Secondary text inside a row (`docs/notes`). `text-muted` is tuned for the
 *  dropdown surface, so on the accent it has to flip, exactly as the search
 *  modal does for its path column. */
const mentionMetaClass = (selected: boolean) => (selected ? 'text-on-accent opacity-80' : 'text-muted')

/** Row chrome of the panels stacked into the composer card — the model picker,
 *  the prompt list and the @mention list share it, so they read as one design. The active
 *  model keeps a persistent highlight so a long list still shows what is
 *  selected at a glance. The hover tint is only on unselected rows, or hovering
 *  would paint over the highlight. */
const panelRowClass = (selected: boolean, highlighted = false) =>
  `flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded px-2.5 py-1.5 text-left ${CONTROL_TEXT} ` +
  (selected ? 'bg-accent text-on-accent' : highlighted ? 'bg-surface-active' : 'hover:bg-surface-active')

/** Above this many models (every provider's list together) the picker grows a
 *  search box: a short list is faster to scan than to type into, while a
 *  gateway serving dozens of models is unusable without a filter. */
const MODEL_SEARCH_THRESHOLD = 10

/** Height bounds of a stacked panel's list (the model picker's, the @mention
 *  list's), in px. The list grows the composer card upward, so
 *  its cap is the room actually visible above the card's bottom edge: the
 *  visual viewport (what is left above an on-screen keyboard) minus the tab bar
 *  and the rest of the card. Never taller than 16rem, never shorter than three
 *  rows — below that the list is no longer scannable, and the card may then
 *  overlap the tab bar rather than offer an unusable sliver. */
const PANEL_LIST_MAX = 256
const PANEL_LIST_MIN = 96
/** Room kept clear at the top of the visible area: the 48px tab bar plus a gap. */
const PANEL_LIST_TOP_GAP = 56


/** True while BlockNote's mobile formatting toolbar (0.55) is up — the strip
 *  above the on-screen keyboard that shares the composer's bottom edge. */
function useMobileToolbar(): boolean {
  const [up, setUp] = useState(false)
  useEffect(() => observeMobileToolbar(setUp), [])
  return up
}

export default function AiFloatingChat({ scrollContainer, obscured = false }: { scrollContainer?: HTMLDivElement | null; obscured?: boolean }) {
  const editor = useEditorStore((s) => s.blockEditor)
  const vaultPath = useVaultStore((s) => s.vaultPath)
  const { selectionPromptOpen, expanded, input, focusRequest, mentionNotice, setExpanded, setInput, setSelectionPromptOpen, setMentionNotice } = useAiChat()
  const provider = useAiSettings((s) => s.provider)
  const model = useAiSettings((s) => s.model)
  const savedProviders = useAiSettings((s) => s.savedProviders)
  const baseUrls = useAiSettings((s) => s.baseUrls)
  const setProvider = useAiSettings((s) => s.setProvider)
  const setModel = useAiSettings((s) => s.setModel)
  const markSelectionDirty = useAiSettings((s) => s.markSelectionDirty)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  /** Model search text and the keyboard-highlighted match (-1 = none yet). Both
   *  reset on every open, so a stale filter never hides a list. */
  const [modelQuery, setModelQuery] = useState('')
  const [modelHighlight, setModelHighlight] = useState(-1)
  const modelSearchRef = useRef<HTMLInputElement>(null)
  const modelHighlightRef = useRef<HTMLButtonElement>(null)
  /** The card and the list of whichever stacked panel is open (the model
   *  picker's or the @mention list's — never both, see `openModelPicker`),
   *  measured to fit that list into the visible height (see PANEL_LIST_MAX).
   *  `undefined` until the first measure. */
  const surfaceRef = useRef<HTMLDivElement>(null)
  const modelListRef = useRef<HTMLDivElement>(null)
  const mentionListRef = useRef<HTMLDivElement>(null)
  const [panelListMax, setPanelListMax] = useState<number>()
  const defaultModels = useAiSettings((s) => s.defaultModels)
  const [modelOptions, setModelOptions] = useState<Record<string, ProviderModels>>({})
  /** Identity of the latest discovery: a slow reply from an earlier open must
   *  not overwrite the lists of a newer one. */
  const discoveryRun = useRef(0)

  const modelPickerRef = useRef<HTMLDivElement>(null)
  const modelTriggerRef = useRef<HTMLButtonElement>(null)
  const modelActiveRef = useRef<HTMLButtonElement>(null)
  const aiConfigured = !!provider && savedProviders.includes(provider)
  const [picker, setPicker] = useState<{ start: number; end: number; query: string } | null>(null)
  const [index, setIndex] = useState<{ vault: string; entries: TreeEntry[]; unreadable: number } | null>(null)
  const [activeOption, setActiveOption] = useState(0)
  const indexRequest = useRef(0)
  const activeOptionRef = useRef<HTMLButtonElement>(null)
  const pickerOpen = picker !== null
  const rootRef = useRef<HTMLDivElement>(null)
  /** True while BlockNote's mobile formatting toolbar is up: the IME belongs to
   *  the document, and the composer collapses below (see `covered`). */
  const imeToolbarUp = useMobileToolbar()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  /** True between compositionstart and compositionend on the prompt box. The
   *  IME owns every key while it is set — including the Escape that cancels a
   *  candidate strip — however `event.isComposing` reports it: Android IMEs
   *  routinely deliver that Escape with `isComposing: false`, so trusting the
   *  flag alone let the window listener tear the menu down mid-composition and
   *  wedge the keyboard (the crash reported from a phone IME). */
  const composingRef = useRef(false)
  /** Enter sends only where a hardware keyboard is the norm. On a phone or
   *  tablet the on-screen keyboard has no Shift+Enter, so its Return key is the
   *  only way to start a new line; the send button (arrow up) sends. */
  const enterSends = useMemo(() => !softKeyboardOnFocus(), [])
  /** When the last composition committed. A ref, not an effect-local: the
   *  keydown effect re-mounts on every picker/menu change and must not forget
   *  the commit it is still guarding. */
  const compositionEndedAtRef = useRef(-Infinity)
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

  /** Latest interaction guards for the scroll listener below. Status comes
   *  from the rust-ai store, so it is not part of the component's own render. */
  const scrollGuards = useRef({ expanded, pickerOpen, selectionPromptOpen, hasInput, status })
  useEffect(() => { scrollGuards.current = { expanded, pickerOpen, selectionPromptOpen, hasInput, status } })

  /** Collapsed by scroll direction, by the mobile sidebar drawer covering the
   *  editor (the portaled drawer would otherwise render UNDER this z-50 surface
   *  and the composer would float over it while open), or by BlockNote's mobile
   *  formatting toolbar being up — while the reader is editing the document on a
   *  phone, the composer steps out of that strip instead of being lifted above
   *  it; it comes back when the toolbar goes, draft intact. */
  const [hideOnScroll, setHideOnScroll] = useState(false)
  const covered = hideOnScroll || obscured || imeToolbarUp

  /* oxlint-disable react/set-state-in-effect -- focusRequest is an external event (⌃⌥L / toolbar prompt); revealing the composer must not wait for another render */
  useEffect(() => { if (focusRequest) { setHideOnScroll(false); inputRef.current?.focus({ preventScroll: true }) } }, [focusRequest])
  /* oxlint-enable react/set-state-in-effect */
  useEffect(() => {
    if (!obscured) return
    const active = document.activeElement
    if (active instanceof HTMLElement && rootRef.current?.contains(active)) active.blur()
  }, [obscured])
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
    if (aiMenu.status === 'thinking' || aiMenu.status === 'generating' || aiMenu.status === 'ai-writing') ai.abort?.('dismissed by user').catch(() => {})
    else if (aiMenu.status === 'user-reviewing' || aiMenu.status === 'error') ai.rejectChanges()
    else ai.closeAIMenu()
    setExpanded(false)
  }, [ai, aiMenu, setExpanded])

  const dismissable = expanded || pickerOpen || status === 'user-input'
  useEffect(() => {
    if (!dismissable) return
    const dismissOutside = (event: Event) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setPicker(null)
        close()
        /** Leaving the composer is the same intent as Escape: hand the caret
         *  back so the document is editable and typing lands there, not in the
         *  prompt box (the extension only restores focus where focusing raises
         *  no soft keyboard). */
        editor?.focus?.()
      }
    }
    window.addEventListener('pointerdown', dismissOutside, true)
    return () => window.removeEventListener('pointerdown', dismissOutside, true)
  }, [dismissable, close, editor])

  useEffect(() => {
    if (!expanded && !isOpen && !picker && !modelPickerOpen) return
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      /** Escape is the IME's own cancel while it composes. This listener sits on
       *  window capture, in front of every element handler, so without the guard
       *  canceling a candidate strip would also dismiss the picker/composer.
       *  `composingRef` (compositionstart/end) covers engines that report
       *  `isComposing: false` on that key; the short post-commit window covers
       *  the ones that emit the cancel Escape only after `compositionend`. */
      if (event.isComposing || composingRef.current) return
      if (performance.now() - compositionEndedAtRef.current < POST_COMPOSITION_ESCAPE_MS) return
      /** The model picker sits on top of everything else in the composer, so it
       *  is the first thing Escape closes — with the search box focused, closing
       *  the whole composer instead would throw the typed filter away with it.
       *  Focus goes back to the trigger that opened it. */
      if (modelPickerOpen) { event.preventDefault(); event.stopPropagation(); setModelPickerOpen(false); modelTriggerRef.current?.focus(); return }
      if (picker) { event.preventDefault(); event.stopPropagation(); setPicker(null); return }
      event.preventDefault()
      /** One Escape leaves the composer *and* hands the caret back to the
       *  document. The extension restores focus only where focusing raises no
       *  soft keyboard (`softKeyboardOnFocus`), so on a phone the caret stayed
       *  stuck in the prompt box until the reader tapped the page — the
       *  reported "Escape twice to get back to the editor". An explicit Escape
       *  is the reader asking for the document with the keyboard already up, so
       *  the caret is returned here on every platform. */
      close()
      editor?.focus?.()
    }
    window.addEventListener('keydown', dismissOnEscape, true)
    return () => window.removeEventListener('keydown', dismissOnEscape, true)
  }, [expanded, isOpen, close, picker, editor, modelPickerOpen])

  /** Grow the prompt textarea with its content (multi-line prompts must stay
   *  readable) and shrink back when cleared. CSS max-h caps the growth; longer
   *  prompts scroll inside the box.
   *
   *  caniuse audit (app minimum target = Safari 17.6): scrollHeight + style
   *  height + resize-none + overflow-y-auto are all baseline (~2015), so no
   *  gating needed. Deliberately NOT using `field-sizing: content` — Chrome
   *  123+ / Safari 18.4+ only, which would silently break the auto-grow on
   *  Safari 17.6. */
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
  /** Scroll-direction visibility: scrolling down hides the composer so it stops
   *  covering the document, scrolling up fades it back in. Only a wheel/touch
   *  gesture can change it (see USER_SCROLL_WINDOW) — the browser's own caret
   *  reveals are not the user scrolling. It never hides while it is in use
   *  (focus, input, picker/prompt menus, an active AI run) or when the document
   *  is near its top. The listener mounts once per container — the guards are
   *  read through a ref so per-keystroke re-renders cannot go stale. */
  useEffect(() => {
    const container = scrollContainer
    const root = rootRef.current
    if (!container) return
    let lastY = container.scrollTop
    let frame = 0
    /** When the last wheel/touch gesture reached the container. A scroll after
     *  one is the user's; every other scroll (caret reveal, IME advances,
     *  `scrollIntoView` restores) merely re-syncs `lastY`. */
    let gestureAt = -Infinity
    const markGesture = () => { gestureAt = performance.now() }
    const reveal = () => setHideOnScroll(false)
    const update = () => {
      frame = 0
      const y = container.scrollTop
      const g = scrollGuards.current
      const inUse = g.expanded || g.pickerOpen || g.selectionPromptOpen || g.hasInput || g.status !== 'closed'
      if (inUse || document.activeElement === inputRef.current || y <= TOP_SHOW_THRESHOLD) { lastY = y; reveal(); return }
      const delta = y - lastY
      lastY = y
      if (performance.now() - gestureAt > USER_SCROLL_WINDOW) return
      if (delta > SCROLL_DIRECTION_TOLERANCE) setHideOnScroll(true)
      else if (delta < -SCROLL_DIRECTION_TOLERANCE) reveal()
    }
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update) }
    container.addEventListener('scroll', onScroll, { passive: true })
    container.addEventListener('wheel', markGesture, { passive: true })
    container.addEventListener('touchmove', markGesture, { passive: true })
    container.addEventListener('focusin', reveal)
    root?.addEventListener('focusin', reveal)
    update()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      container.removeEventListener('scroll', onScroll)
      container.removeEventListener('wheel', markGesture)
      container.removeEventListener('touchmove', markGesture)
      container.removeEventListener('focusin', reveal)
      root?.removeEventListener('focusin', reveal)
    }
  }, [scrollContainer])

  useEffect(() => {
    if (!pickerOpen) return
    const vault = vaultPath ?? ''
    const requestId = ++indexRequest.current
    let active = true
    // Reuses the last walk for this vault; only the first opening pays for it.
    loadMentionIndex(vault).then((result) => {
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
      /** One stacked list at a time: typing `@` replaces an open model picker. */
      setModelPickerOpen(false)
    } else setPicker(null)
  }

  const insertMention = (entry: TreeEntry) => {
    const folder = entry.type === '1'
    const token = entry.path + (folder ? '/' : '')
    const quoted = mentionText(token)
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

  const accept = useCallback(() => { setExpanded(false); ai.acceptChanges() }, [ai, setExpanded])
  const revert = () => { setExpanded(false); ai.rejectChanges() }

  useEffect(() => {
    if (status !== 'user-reviewing') return
    const acceptOnShortcut = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.isComposing || composingRef.current) return
      event.preventDefault()
      accept()
    }
    window.addEventListener('keydown', acceptOnShortcut)
    return () => window.removeEventListener('keydown', acceptOnShortcut)
  }, [status, accept])

  const modelProviders = savedProviders.filter((id) => id === CUSTOM_PROVIDER_ID || PROVIDERS.some((item) => item.id === id))
  /** Fetch every configured provider's models from its own endpoint on each
   *  open. Providers load independently, so a slow or failing one neither holds
   *  back nor overwrites another's list. The backend resolves the endpoint it
   *  stored for a configured provider; the URL sent here is only a fallback. */
  const loadModels = () => {
    const run = ++discoveryRun.current
    setModelOptions(Object.fromEntries(modelProviders.map((id) => [id, { status: 'loading', models: [] }])))
    for (const id of modelProviders) {
      const finish = (next: ProviderModels) => {
        if (discoveryRun.current === run) setModelOptions((current) => ({ ...current, [id]: next }))
      }
      const baseUrl = baseUrls[id] || PROVIDERS.find((item) => item.id === id)?.api || ''
      fetchProviderModels(id, baseUrl).then(
        (models) => finish({ status: 'ok', models }),
        () => finish({ status: 'error', models: [] }),
      )
    }
  }
  /** What each provider group lists. A fetched list is shown as the provider
   *  sent it — nothing added, so a model it no longer serves is not offered.
   *  Until it arrives, or when it fails, the backend's default model for that
   *  provider is the only fallback row. */
  const modelGroups = modelProviders.map((id) => {
    const entry = modelOptions[id] ?? { status: 'loading' as const, models: [] }
    const models = entry.status === 'ok'
      ? entry.models.map((option) => option.id)
      : defaultModels[id] ? [defaultModels[id]] : []
    return { id, label: providerGroupLabel(id), status: entry.status, models }
  })
  /** The search box appears once the lists hold more than the threshold, counted
   *  BEFORE filtering so it cannot vanish under the user's own query. A query
   *  matches model ids, case-insensitively; a group with no match is hidden. */
  const modelSearch = modelGroups.reduce((sum, group) => sum + group.models.length, 0) > MODEL_SEARCH_THRESHOLD
  const modelFilter = modelSearch ? modelQuery.trim().toLowerCase() : ''
  const visibleModelGroups = modelFilter
    ? modelGroups
      .map((group) => ({ ...group, models: group.models.filter((option) => option.toLowerCase().includes(modelFilter)) }))
      .filter((group) => group.models.length > 0)
    : modelGroups
  /** Every visible row in display order — what the arrow keys walk and Enter
   *  picks from. Its index is also each row's DOM id, for aria-activedescendant. */
  const modelMatches = visibleModelGroups.flatMap((group) => group.models.map((option) => ({ provider: group.id, model: option })))
  const modelOptionId = (position: number) => `ai-model-option-${position}`
  /** The model picker and the prompt list (the Zap button's) are one-at-a-time:
   *  both stack onto the composer, and two open panels buried the prompt box.
   *  Opening the picker only HIDES the list — the AI menu it opened at the caret
   *  stays, so the prompt typed after the model switch still lands there. */
  const openModelPicker = () => {
    setExpanded(false)
    setPicker(null)
    setModelQuery('')
    setModelHighlight(-1)
    setModelPickerOpen(true)
    void loadModels()
  }
  /** The other direction: showing the prompt list closes the picker. Only the
   *  toggle path — Send (the same button with text in the box) leaves it alone. */
  const togglePromptList = () => {
    if (!expanded) setModelPickerOpen(false)
    useAiChat.getState().togglePrompts()
  }
  /** Focus the search box when it appears, except where focusing raises a soft
   *  keyboard: on a phone that would cover the list the reader came to scan. */
  useEffect(() => {
    if (modelPickerOpen && modelSearch && !softKeyboardOnFocus()) modelSearchRef.current?.focus()
  }, [modelPickerOpen, modelSearch])
  useEffect(() => {
    if (modelHighlight >= 0) modelHighlightRef.current?.scrollIntoView({ block: 'nearest' })
  }, [modelHighlight])
  /** IME-aware list height. The visual viewport is what the reader sees: on iOS
   *  an open keyboard shrinks only it (the layout viewport keeps its height), on
   *  Android `interactive-widget=resizes-content` shrinks both — measuring the
   *  visual one covers both engines. Re-fit whenever it resizes or scrolls (the
   *  keyboard coming up or down, a rotation) and whenever the card itself
   *  changes height (the prompt growing, the search box appearing). The card's
   *  height minus the list's is everything else in it, which the list must not
   *  push out of view. */
  useEffect(() => {
    if (!modelPickerOpen && !pickerOpen) return
    const fit = () => {
      const surface = surfaceRef.current
      const list = modelListRef.current ?? mentionListRef.current
      if (!surface || !list) return
      const viewport = window.visualViewport
      const visibleTop = viewport ? viewport.offsetTop : 0
      const visibleBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight
      const rect = surface.getBoundingClientRect()
      const rest = rect.height - list.offsetHeight
      const room = Math.min(rect.bottom, visibleBottom) - visibleTop - PANEL_LIST_TOP_GAP - rest
      setPanelListMax(Math.max(PANEL_LIST_MIN, Math.min(PANEL_LIST_MAX, Math.floor(room))))
    }
    fit()
    const viewport = window.visualViewport
    viewport?.addEventListener('resize', fit)
    viewport?.addEventListener('scroll', fit)
    window.addEventListener('resize', fit)
    /** Setting the cap changes the card's height, which re-runs `fit` once and
     *  lands on the same value (the rest of the card is unchanged), so the
     *  observer settles instead of looping. jsdom has no ResizeObserver. */
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit)
    if (surfaceRef.current) observer?.observe(surfaceRef.current)
    return () => {
      viewport?.removeEventListener('resize', fit)
      viewport?.removeEventListener('scroll', fit)
      window.removeEventListener('resize', fit)
      observer?.disconnect()
    }
  }, [modelPickerOpen, pickerOpen])
  /** Opening the picker over a long model list must land on the active model:
   *  the listbox is max-h-64 + overflow-y-auto, so the current selection can
   *  sit below the fold, invisible. Re-runs as each provider's list lands, so
   *  the active row still gets its scroll once it appears. */
  useEffect(() => {
    if (!modelPickerOpen) return
    modelActiveRef.current?.scrollIntoView({ block: 'nearest' })
  }, [modelPickerOpen, modelOptions, provider, model])
  const selectModel = (id: string, nextModel: string) => {
    if (!nextModel) return
    setProvider(id)
    /** The model is filed against the provider the pick was MADE for, passed
     *  explicitly — not against whatever provider the store holds by then, which
     *  made this pair order-dependent. */
    setModel(id, nextModel)
    /** A composer pick is session-local until Settings saves it — tell hydration
     *  (which may still be retrying from boot) not to clobber it with the
     *  backend's stale active model. */
    markSelectionDirty()
    /** The search box unmounts with the picker; leaving focus on it would drop
     *  focus to <body>. The trigger is where it came from. */
    if (document.activeElement === modelSearchRef.current) modelTriggerRef.current?.focus()
    setModelPickerOpen(false)
    /** Measure the pick now, while the user types the prompt: an unmeasured
     *  model runs text-only. Resolved like the transport resolves it, so an
     *  env-controlled endpoint measures the env model it actually sends. */
    void getAiConfig().then(({ provider: active, model: sent }) => {
      if (active && sent) void ensureToolProbe(active, sent)
    })
  }
  useEffect(() => {
    if (!modelPickerOpen) return
    const dismissOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (!modelPickerRef.current?.contains(target) && !modelTriggerRef.current?.contains(target)) setModelPickerOpen(false)
    }
    document.addEventListener('mousedown', dismissOutside)
    return () => document.removeEventListener('mousedown', dismissOutside)
  }, [modelPickerOpen])

  if (!ai) return null

  /** Arrow keys walk the visible rows, Enter picks the highlighted one — or the
   *  first match when the reader typed and went straight to Enter. Escape is the
   *  composer-wide window handler's (it closes this picker first). */
  const onModelSearchKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!modelMatches.length) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setModelHighlight((current) => current < 0 ? (step > 0 ? 0 : modelMatches.length - 1) : (current + step + modelMatches.length) % modelMatches.length)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const target = modelMatches[modelHighlight] ?? (modelFilter ? modelMatches[0] : undefined)
      if (target) selectModel(target.provider, target.model)
    }
  }
  /** Rows are numbered across groups (one sequence for the whole list), so the
   *  running position is threaded through the group render. */
  let modelPosition = 0
  /** A panel INSIDE the composer card, stacked above the prompt the way the
   *  "Writing… / Stop" status bar is — not a popover floating over the card. It
   *  takes the card's full width (model ids are long; a fixed 16rem box clipped
   *  them on a phone while the composer had room to spare), and the card grows
   *  upward from its anchored bottom edge to make room. Flat like the status
   *  bar: no own border, background or shadow, just the hairline below it. */
  const modelPicker = modelPickerOpen && (
    <div ref={modelPickerRef} className="ai-chat-panel flex flex-col border-b border-border-subtle">
      {modelSearch && (
        <div className="px-2 pt-2">
          <input ref={modelSearchRef} type="text" value={modelQuery} onChange={(event) => { setModelQuery(event.target.value); setModelHighlight(event.target.value.trim() ? 0 : -1) }} onKeyDown={onModelSearchKey}
            placeholder="Search models…" aria-label="Search models" role="combobox" aria-expanded="true" aria-controls="ai-model-listbox" aria-autocomplete="list"
            aria-activedescendant={modelHighlight >= 0 && modelHighlight < modelMatches.length ? modelOptionId(modelHighlight) : undefined}
            autoComplete="off" spellCheck={false} enterKeyHint="go"
            onCompositionStart={() => { composingRef.current = true }} onCompositionEnd={() => { composingRef.current = false; compositionEndedAtRef.current = performance.now() }}
            className={`w-full rounded-md border border-border bg-background px-2.5 py-1.5 ${CONTROL_TEXT} text-foreground outline-none placeholder:text-muted focus:border-accent`} />
        </div>
      )}
      <div id="ai-model-listbox" ref={modelListRef} style={panelListMax === undefined ? undefined : { maxHeight: panelListMax }} className="max-h-64 overflow-y-auto overscroll-contain p-1" role="listbox" aria-label="AI models">
      {visibleModelGroups.map((group) => (
        <div key={group.id} role="group" aria-labelledby={`ai-model-group-${group.id}`}>
          <div id={`ai-model-group-${group.id}`} role="presentation" className={PANEL_HEADER_CLASS}>{group.label}</div>
          {group.models.map((option) => {
            const active = group.id === provider && option === model
            const position = modelPosition++
            const highlighted = position === modelHighlight
            /** `title` carries the full id: the row truncates, and two ids that
             *  differ only at the end look identical once cut. */
            return <button key={`${group.id}:${option}`} id={modelOptionId(position)} ref={(node) => { if (active) modelActiveRef.current = node; if (highlighted) modelHighlightRef.current = node }} role="option" aria-selected={active} title={option} onMouseDown={(event) => event.preventDefault()} onClick={() => selectModel(group.id, option)} className={panelRowClass(active, highlighted)}><span className="min-w-0 flex-1 truncate font-mono">{option}</span>{active && <Check size={11} className="shrink-0" />}</button>
          })}
          {group.status === 'loading' && <div role="presentation" className="px-2.5 py-1 text-[11px] text-muted">Loading models…</div>}
          {group.status === 'error' && <div role="presentation" className="px-2.5 py-1 text-[11px] text-muted">Could not load models</div>}
          {group.status === 'ok' && group.models.length === 0 && <div role="presentation" className="px-2.5 py-1 text-[11px] text-muted">No models found</div>}
        </div>
      ))}
      {modelFilter && !modelMatches.length && <div role="presentation" className="px-2.5 py-1.5 text-[11px] text-muted">No matching models</div>}
      </div>
    </div>
  )

  /** The Zap button's prompt list, stacked into the card exactly like the model
   *  picker (same panel, header and rows) instead of chips floating above it.
   *  It never shares the card with the status bar — the list only exists in
   *  `user-input`, the bar only while AI works, waits for review or failed —
   *  and the picker closes it (one panel at a time), so it simply sits on top. */
  const promptListOpen = aiConfigured && !selectionPromptOpen && status === 'user-input' && expanded && !hasInput && items.length > 0
  const promptPanel = promptListOpen && (
    <div className="ai-chat-panel flex flex-col border-b border-border-subtle p-1" role="group" aria-labelledby="ai-prompt-group">
      <div id="ai-prompt-group" role="presentation" className={PANEL_HEADER_CLASS}>Suggestions</div>
      {items.map((item) => <button key={item.key} onClick={item.onItemClick} onMouseDown={(event) => event.preventDefault()} className={panelRowClass(false)}><span className="flex w-4 shrink-0 items-center justify-center text-accent [&_svg]:size-3.5">{item.icon}</span><span className="min-w-0 truncate">{item.title}</span></button>)}
    </div>
  )

  /** The @mention list, stacked into the card right above the prompt box the
   *  way the model picker and the suggestions are — not a popover floating over
   *  the card. Its list shares their row chrome and the IME-aware height (it is
   *  open while the reader types, so on a phone the keyboard is up). The prompt
   *  box keeps focus and owns `aria-activedescendant`. In a row the folder hint
   *  is what tells duplicate basenames apart, so it keeps its width (`shrink-0`,
   *  capped at half the row) and the NAME truncates first: shrinking both cut a
   *  long duplicate's hint to "d…" on a phone, where `docs` and `docs/notes`
   *  then read the same. */
  const mentionPanel = picker && (
    <div className="ai-chat-panel flex flex-col border-b border-border-subtle p-1">
      <div role="presentation" className={PANEL_HEADER_CLASS}>Context</div>
      <div id={MENTION_LISTBOX_ID} ref={mentionListRef} role="listbox" aria-label="Mention files and folders" style={panelListMax === undefined ? undefined : { maxHeight: panelListMax }} className="max-h-64 overflow-y-auto overscroll-contain">
        {visibleEntries.length ? visibleEntries.map((entry, position) => {
          const selected = entry === activeEntry
          return <button key={entry.path} ref={selected ? activeOptionRef : undefined} id={optionId(position)} role="option" aria-selected={selected} title={entry.path} onMouseDown={(event) => event.preventDefault()} onClick={() => insertMention(entry)} className={panelRowClass(selected)}>{entry.type === '1' ? <Folder size={14} className="shrink-0" /> : <FileText size={14} className="shrink-0" />}<span className="min-w-0 truncate">{entry.name}</span>{ambiguousNames.has(entry.name.toLowerCase()) && parentOf(entry.path) && <span className={'max-w-[50%] shrink-0 truncate text-[10px] ' + mentionMetaClass(selected)}>{parentOf(entry.path)}</span>}</button>
        }) : <div className="px-2.5 py-1.5 text-[11px] text-muted">{currentIndex && currentIndex.unreadable > 0 && currentIndex.entries.length === 0 ? 'Could not read the vault — try again' : indexLoading ? 'Loading vault…' : 'No matching files or folders'}</div>}
        {currentIndex && currentIndex.unreadable > 0 && visibleEntries.length > 0 && <div className="px-2.5 py-1 text-[10px] text-muted">{currentIndex.unreadable} folder{currentIndex.unreadable === 1 ? '' : 's'} could not be read</div>}
      </div>
    </div>
  )

  const promptInput = (
    <>
      {mentions.length > 0 && <div className="flex flex-wrap gap-1 px-3 pt-2">{mentions.map((mention) => <span key={`${mention.start}:${mention.end}`} className="flex items-center gap-1 rounded-full bg-accent-subtle px-2 py-1 text-[11px] text-accent"><FileText size={11} />{mention.token}<button aria-label={`Remove @${mention.token}`} className="p-1 cursor-pointer hover:text-foreground" onClick={() => removeMention(mention)}><X size={11} /></button></span>)}</div>}
      {mentionNotice && <div className="px-3 pt-1 text-[10px] text-muted">{mentionNotice}</div>}
      {/* The textarea owns the full width: a send button beside it reserved its
          column on every line, so text wrapped well before the bubble's edge. */}
      <div className="flex w-full min-w-0 px-2 pt-2">
        <textarea ref={inputRef} value={input} onChange={(event) => onInputChange(event.target.value, event.target.selectionStart)} onCompositionStart={() => { composingRef.current = true }} onCompositionEnd={() => { composingRef.current = false; compositionEndedAtRef.current = performance.now() }} onKeyDown={(event) => {
          /** While an IME composes (candidate strip open), its keys belong to it:
           *  the Enter that commits a candidate would otherwise send the prompt,
           *  and the candidate arrows would walk the mention picker instead.
           *  Same guard as the markdown editor's Enter and the link toolbar. */
          if (event.nativeEvent.isComposing) return
          if (picker && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); setActiveOption((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + visibleEntries.length) % Math.max(visibleEntries.length, 1)); return }
          if (picker && event.key === 'Enter' && activeEntry) { event.preventDefault(); insertMention(activeEntry); return }
          if (picker && event.key === 'Tab' && activeEntry) { event.preventDefault(); insertMention(activeEntry); return }
          if (event.key === 'Backspace' && !input && mentions.length) { event.preventDefault(); removeMention(mentions[mentions.length - 1]); return }
          if (event.key === 'Enter' && enterSends && !event.shiftKey && !event.metaKey && !event.ctrlKey && hasInput && promptEnabled) { event.preventDefault(); submit() }
        }} rows={1} enterKeyHint={enterSends ? 'send' : 'enter'} role="combobox" aria-label="AI prompt" aria-expanded={pickerOpen} aria-controls={pickerOpen ? MENTION_LISTBOX_ID : undefined} aria-autocomplete="list" aria-activedescendant={pickerOpen && activeEntry ? optionId(activeIndex) : undefined} disabled={!promptEnabled} placeholder={aiConfigured ? 'Message the Agent, @ to include context' : 'Configure API key in Settings (⌘,)'} title={aiConfigured ? (enterSends ? 'Enter to send · Shift+Enter for new line' : 'Return for new line · arrow button to send') : 'Configure an API key in Settings (⌘,)'} className={`min-h-7 max-h-30 min-w-0 flex-1 resize-none overflow-y-auto border-none bg-transparent px-1.5 py-1.5 ${CONTROL_TEXT} text-foreground outline-none placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-60`} />
      </div>
      <div className="relative flex min-w-0 items-center justify-between gap-2 px-2 pb-2">
        <button ref={modelTriggerRef} type="button" disabled={!aiConfigured} onClick={() => { if (modelPickerOpen) setModelPickerOpen(false); else openModelPicker() }} aria-label="Select AI model" title={aiConfigured ? (model ? `Select AI model (${model})` : 'Select AI model') : 'Configure an API key in Settings (⌘,)'} aria-expanded={modelPickerOpen} aria-controls={modelPickerOpen ? 'ai-model-listbox' : undefined} className={`flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded px-1.5 py-1 ${CONTROL_TEXT} text-muted hover:bg-surface-active hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent sm:px-2`}>
          {/* Narrower below 640px: the label caps at 8rem there (13rem above) and
              ends in an ellipsis, so a long gateway id cannot crowd the row. */}
          <span className="min-w-0 max-w-32 truncate font-mono sm:max-w-52">{model || 'Select model'}</span><ChevronsUpDown size={11} className="shrink-0" />
        </button>
        {(hasInput || !selectionPromptOpen) && <button onClick={hasInput ? submit : togglePromptList} onMouseDown={(event) => event.preventDefault()} disabled={!aiConfigured || (hasInput ? !canPrompt : !canTogglePrompts)} aria-label={hasInput ? 'Send prompt' : expanded ? 'Hide AI prompts' : 'Show AI prompts'} aria-expanded={!hasInput && canTogglePrompts ? expanded : undefined} title={hasInput ? (enterSends ? 'Send prompt (Enter)' : 'Send prompt') : 'AI prompts'} className={'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border-none cursor-pointer disabled:cursor-not-allowed disabled:opacity-35 ' + (hasInput ? 'bg-accent text-on-accent hover:bg-accent-hover' : 'bg-transparent text-foreground hover:bg-surface-active')}>{hasInput ? <ArrowUp size={16} /> : expanded ? <X size={16} /> : <Zap size={16} />}</button>}
      </div>
    </>
  )

  const outOfRetries = typeof aiMenu !== 'string' && aiMenu.status === 'error' && aiMenu.retriesLeft === 0

  const statusBar = status === 'thinking' || status === 'generating' || status === 'ai-writing' ? <div className="ai-chat-status flex items-center gap-2 border-b border-border-subtle px-3 py-2"><Loader2 size={13} className="animate-spin text-accent" /><span className="text-xs text-foreground-secondary">{status === 'thinking' ? 'Thinking…' : status === 'generating' ? 'Generating…' : 'Writing…'}</span><button onClick={() => { setExpanded(false); ai.abort?.('stopped by user').catch(() => {}) }} className={`ml-auto cursor-pointer rounded border border-border-subtle bg-surface-active px-2 py-1 ${CONTROL_TEXT} text-foreground-secondary hover:text-foreground`}>Stop</button></div> : status === 'user-reviewing' ? <div className="ai-chat-status flex items-center gap-2 border-b border-border-subtle px-3 py-2"><span className="text-xs text-foreground-secondary">Review the changes</span><div className="ml-auto flex items-center gap-2"><button onClick={revert} onMouseDown={(event) => event.preventDefault()} className={`cursor-pointer rounded border border-border-subtle bg-surface-active px-2.5 py-1 ${CONTROL_TEXT} text-foreground-secondary hover:text-foreground`}>Revert</button><button onClick={accept} onMouseDown={(event) => event.preventDefault()} className={`flex cursor-pointer items-center gap-1 rounded border-none bg-accent px-2.5 py-1 ${CONTROL_TEXT} text-on-accent hover:bg-accent-hover`}><Check size={11} />Accept <span className="ml-1 inline-flex items-center gap-0.5 opacity-80"><Command size={10} /><CornerDownLeft size={10} /></span></button></div></div> : status === 'error' ? <div className="ai-chat-status border-b border-border-subtle px-3 py-2"><div className="wrap-break-word text-[11px] text-danger">{typeof aiMenu !== 'string' && aiMenu.error ? String(aiMenu.error?.message ?? aiMenu.error) : 'Something went wrong'}</div>{outOfRetries && <div className="mt-1 text-[10px] text-muted">Retry limit reached — rephrase the prompt or cancel.</div>}<div className="mt-2 flex justify-end gap-2"><button onClick={() => { setExpanded(false); ai.rejectChanges() }} className={`cursor-pointer rounded border border-border-subtle bg-surface-active px-2.5 py-1 ${CONTROL_TEXT} text-foreground-secondary hover:text-foreground`}>Cancel</button><button disabled={outOfRetries} onClick={() => { setExpanded(false); ai.retry()?.catch(() => {}) }} className={`flex cursor-pointer items-center gap-1 rounded border-none bg-accent px-2.5 py-1 ${CONTROL_TEXT} text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-35`}><RotateCcw size={11} />Retry</button></div></div> : null

  return <div ref={rootRef} aria-hidden={obscured || undefined} data-ai-chat-hidden={covered ? 'true' : 'false'} className="editor-ai-floating absolute bottom-5 left-1/2 z-50 flex flex-col items-end gap-2">
    <div ref={surfaceRef} className="ai-chat-surface relative flex w-full flex-col overflow-visible rounded-xl border border-border transition-colors focus-within:border-accent">{promptPanel}{statusBar}{modelPicker}{mentionPanel}{promptInput}</div>
  </div>
}
