import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { X, Check, ChevronDown, ChevronLeft, ChevronRight, Share } from 'lucide-react'
import { toast } from 'sonner'
import { useEditorStore } from '../../stores/editor'
import { invoke, isMacTauri, isTauri } from '../../lib/ipc'
import { editorFileKind } from '../../utils/fileKind'
import { useClickOutside } from '../../hooks/useClickOutside'
import { SidebarToggle } from '../SidebarToggle'
import { TopBarShell } from '../TopBarShell'
import { EditorActionsMenu } from './editorActions'
import { buildEditorActions, type EditorApp } from './editorActionItems'

/** Ties the count badge to the popover it expands (`aria-controls`). */
const TABS_MENU_ID = 'editor-tab-switcher'

export function TabBar({ sidebarOpen, isDesktop, sidebarToggleRef, onToggleSidebar, onOpenSearch }: { sidebarOpen: boolean; isDesktop: boolean; sidebarToggleRef: RefObject<HTMLButtonElement | null>; onToggleSidebar: () => void; onOpenSearch: () => void }) {
  const { undo, redo, canUndo, canRedo } = useEditorStore()
  const { activeTab, tabs, switchTab, closeTab, editMode } = useEditorStore()
  const [actionsOpen, setActionsOpen] = useState(false)
  /** Compact tab switcher: below 640px only the active tab is rendered, so the
   *  count badge on it is the only way to reach another open tab. */
  const [tabsOpen, setTabsOpen] = useState(false)
  const badgeRef = useRef<HTMLButtonElement>(null)
  const tabsMenuRef = useRef<HTMLDivElement>(null)
  /** Which row takes focus when the switcher opens: the open tab for a click,
   *  the last row for ArrowUp (menu-button pattern). */
  const initialFocusRef = useRef<'checked' | 'first' | 'last'>('checked')
  /** The menu is a sibling of the trigger (it spans the bar, not the tab), so
   *  dismissing on an outside press needs both elements, not one ref. */
  useEffect(() => {
    if (!tabsOpen) return
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (!target) return
      if (tabsMenuRef.current?.contains(target) || badgeRef.current?.contains(target)) return
      setTabsOpen(false)
    }
    window.addEventListener('mousedown', onMouseDown)
    return () => window.removeEventListener('mousedown', onMouseDown)
  }, [tabsOpen])
  /** Detected editors are cached per file path, so a slow response for the
   *  previous tab can never paint under the current one. */
  const [detected, setDetected] = useState<{ forPath: string | null; list: EditorApp[] }>({ forPath: null, list: [] })
  const actionsRef = useRef<HTMLSpanElement>(null)
  useClickOutside(actionsRef, () => setActionsOpen(false))
  const file = useEditorStore(s => s.tabs.find(t => t.path === s.activeTab))
  /** Compact web (<640px, Docker/web only — native macOS untouched):
   *  single row keeps [panel|search] + tabs + Actions; undo/redo + mode
   *  toggle move into the Actions menu. Every other layout uses the same menu
   *  behind an icon trigger. Git actions live in Changes. */
  const compact = !isTauri && !isDesktop
  /** Trigger presentation is pure viewport width, independent of runtime: below
   *  640px the menu stays the compact text trigger, at/above it becomes the
   *  icon trigger. `compact` still owns the web-only layout changes. */
  const compactTrigger = !isDesktop
  const visibleTabs = compact ? tabs.filter(tab => tab.path === activeTab) : tabs
  /** Compact renders exactly one row, so the row is keyed by a constant: the
   *  node (and the focused badge inside it) survives a tab switch instead of
   *  being replaced, which would drop focus on the body. */
  const tabRowKey = (path: string) => (compact ? 'compact-active-tab' : path)
  /** A single tab needs no switcher — the badge would only list the tab you are
   *  already looking at. */
  const showTabCount = compact && tabs.length > 1

  /** The last extra tab closing (Cmd+W) must not leave a switcher for a list
   *  that no longer exists. */
  /* oxlint-disable react/set-state-in-effect -- closes the switcher with its list */
  useEffect(() => { if (!showTabCount) setTabsOpen(false) }, [showTabCount])
  /* oxlint-enable react/set-state-in-effect */

  /** Open on the tab you are looking at, so the first Enter keeps you there
   *  instead of jumping somewhere else. `scrollIntoView` is absent in jsdom. */
  useEffect(() => {
    const menu = tabsMenuRef.current
    if (!tabsOpen || !menu) return
    const rows = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
    const checked = rows.find(row => row.getAttribute('aria-checked') === 'true')
    const target = initialFocusRef.current === 'last' ? rows[rows.length - 1]
      : initialFocusRef.current === 'first' ? rows[0]
      : checked ?? rows[0]
    initialFocusRef.current = 'checked'
    target?.focus()
    target?.scrollIntoView?.({ block: 'nearest' })
  }, [tabsOpen])

  /** Picking a tab closes the switcher, which would otherwise drop focus on the
   *  body; hand it back to the trigger that opened it. */
  const selectTab = (path: string) => {
    void switchTab(path)
    setTabsOpen(false)
    badgeRef.current?.focus()
  }

  /** Arrow keys are part of the menu pattern the popover already claims. Without
   *  them the switcher — the only way to reach another tab below 640px — could
   *  not be driven from the keyboard at all. */
  const onTabsMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
    if (rows.length === 0) return
    const current = rows.indexOf(document.activeElement as HTMLButtonElement)
    const focusAt = (index: number) => rows[(index + rows.length) % rows.length].focus()
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusAt(current + 1); break
      case 'ArrowUp': e.preventDefault(); focusAt(current - 1); break
      case 'Home': e.preventDefault(); focusAt(0); break
      case 'End': e.preventDefault(); focusAt(rows.length - 1); break
      case 'Escape': e.preventDefault(); setTabsOpen(false); badgeRef.current?.focus(); break
      case 'Tab': setTabsOpen(false); break
    }
  }

  const filePath = file?.path
  const fileDeleted = !!file?.deleted
  const editors = detected.forPath === filePath ? detected.list : []
  /** Fetch on open, not in an effect: the menu is the only consumer, and a
   *  failure just falls back to the generic "Open in editor" row. */
  const toggleActions = () => {
    const next = !actionsOpen
    setActionsOpen(next)
    if (!next || !isTauri || !filePath || fileDeleted) return
    invoke<EditorApp[]>('list_editors', { path: filePath })
      .then(list => setDetected({ forPath: filePath, list: Array.isArray(list) ? list : [] }))
      .catch(() => setDetected({ forPath: filePath, list: [] }))
  }
  const closeActions = () => setActionsOpen(false)
  /** Only .md files can toggle Editor ↔ Code; a read-only diff tab cannot. */
  const toggleable = file ? editorFileKind(file.path) === 'wysiwyg' && file.view !== 'diff' : false

  /** External editor reads the file from disk, so pending autosave edits must
   *  land first — otherwise the editor opens a stale document. */
  const openInEditor = async (app?: string) => {
    if (!file) return
    try {
      await useEditorStore.getState().persistAllDirty()
      await invoke('open_in_editor', { path: file.path, app: app ?? null })
    } catch (error) {
      toast.error(String(error))
    }
  }
  const revealInFinder = async () => {
    if (!file) return
    try { await invoke('reveal_in_finder', { path: file.path }) }
    catch (error) { toast.error(String(error)) }
  }
  const actions = buildEditorActions({
    canUndo, canRedo, onUndo: undo, onRedo: redo, includeHistory: compactTrigger,
    editMode, toggleable, hasFile: !!file, fileDeleted,
    editors: isTauri ? editors : [],
    onToggleMode: () => { void useEditorStore.getState().toggleEditMode(); closeActions() },
    onOpenInEditor: isTauri ? (app?: string) => { closeActions(); void openInEditor(app) } : undefined,
    onRevealInFinder: isTauri ? () => { closeActions(); void revealInFinder() } : undefined,
    revealLabel: isMacTauri ? 'Reveal in Finder' : 'Reveal in File Manager',
  })

  /** Subscribe to activeTab separately for tab-switch effect */
  const curTab = useEditorStore(s => s.activeTab)

  /** Keep the active tab visible — when switching to a tab beyond the visible
   *  edge (overflow-x), auto-scroll it into view instead of forcing the user
   *  to manually scroll the tab strip. A small end-margin keeps the tab from
   *  sitting flush against the strip edge. */
  const tabStripRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const strip = tabStripRef.current
    if (!strip || !curTab) return
    const el = strip.querySelector(`[data-tab-path="${CSS.escape(curTab)}"]`) as HTMLElement | null
    if (!el) return
    const sl = strip.scrollLeft
    const sr = strip.getBoundingClientRect()
    const er = el.getBoundingClientRect()
    const left = er.left - sr.left
    const right = er.right - sr.left
    if (right > sr.width - 8) {
      strip.scrollLeft = sl + (right - sr.width) + 8   // scroll right, +8 margin
    } else if (left < 8) {
      strip.scrollLeft = Math.max(0, sl + left - 8)    // scroll left, -8 margin
    }
  }, [curTab])

  return (
    /** The bar is the full-width chrome strip (background + hairline + drag
     *  region); `-track` inside is the layout row, so the background spans edge
     *  to edge on wide displays where the row itself is centred and capped. */
    <TopBarShell dragRegion={isMacTauri} className={(compact ? 'gap-2 pl-4 pr-4 ' : 'gap-3 pr-6 ') + (!compact && isMacTauri && !sidebarOpen ? 'pl-20' : !compact ? 'pl-6' : '')}>
      <SidebarToggle sidebarOpen={sidebarOpen} isDesktop={isDesktop} sidebarToggleRef={sidebarToggleRef} onToggleSidebar={onToggleSidebar} onOpenSearch={onOpenSearch} />
      {!compactTrigger && (
      <span className="inline-flex shrink-0 items-center rounded-md border border-border-subtle bg-background">
        <button onClick={() => undo()} disabled={!canUndo} title="Undo" aria-label="Undo" className="rounded cursor-pointer text-foreground-subtle hover:text-foreground-secondary hover:bg-surface-active disabled:opacity-30 disabled:cursor-not-allowed min-w-10 sm:min-w-8 p-2 flex items-center justify-center"><ChevronLeft size={16} /></button>
        <button onClick={() => redo()} disabled={!canRedo} title="Redo" aria-label="Redo" className="rounded cursor-pointer text-foreground-subtle hover:text-foreground-secondary hover:bg-surface-active disabled:opacity-30 disabled:cursor-not-allowed min-w-10 sm:min-w-8 p-2 border-l border-border-subtle flex items-center justify-center"><ChevronRight size={16} /></button>
      </span>
      )}
      <div ref={tabStripRef} data-tauri-drag-region={isMacTauri ? true : undefined} className={'tab-strip flex-1 min-w-0 flex items-stretch h-full overflow-y-hidden scrollbar-none ' + (compact ? 'overflow-hidden' : 'overflow-x-auto')}>
        {tabs.length === 0 ? <span className="text-foreground-subtle italic self-center">No file open</span> : visibleTabs.map(tab => (
          <div key={tabRowKey(tab.path)} data-tab-path={tab.path} onClick={() => switchTab(tab.path)}
            className={'tab-item flex items-center justify-center relative cursor-pointer ' + (compact ? 'flex-1 min-w-0 pl-4 pr-1 gap-1 ' : 'whitespace-nowrap shrink-0 px-8 ') + (activeTab === tab.path ? 'tab-active text-foreground' : 'tab-inactive text-foreground-subtle')}>
            <span title={compact ? tab.name : undefined} className={(compact ? 'min-w-0 flex-1 truncate ' : '') + (tab.deleted ? 'line-through opacity-50' : '')}>{tab.name}</span>
            {showTabCount && (
              <button ref={badgeRef} type="button" onClick={e => { e.stopPropagation(); setTabsOpen(value => !value) }}
                onKeyDown={e => {
                  if (e.key === 'Escape') { setTabsOpen(false); return }
                  // A menu button also opens on the arrow keys that navigate it.
                  if (!tabsOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                    e.preventDefault()
                    initialFocusRef.current = e.key === 'ArrowUp' ? 'last' : 'checked'
                    setTabsOpen(true)
                  }
                }} aria-label={`Open tabs (${tabs.length})`} aria-haspopup="menu" aria-expanded={tabsOpen} aria-controls={tabsOpen ? TABS_MENU_ID : undefined} title={`${tabs.length} open tabs`}
                className="flex h-5 min-w-5 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border-subtle bg-background px-1.5 text-[10px] font-semibold text-foreground-secondary transition-colors hover:border-border hover:text-foreground">{tabs.length}</button>
            )}
            <button onClick={e => { e.stopPropagation(); closeTab(tab.path) }} aria-label={'Close ' + tab.name} style={compact ? { opacity: 1, pointerEvents: 'auto' } : undefined} className={'tab-close-btn border-none bg-transparent cursor-pointer p-1 rounded text-foreground-subtle transition-opacity ' + (compact ? 'shrink-0' : 'absolute right-1')}><X size={14} /></button>
          </div>
        ))}
      </div>

      {/* Anchored to the bar, not the badge: a menu pinned to the tab would run
          off the edge of a 320px screen, while the bar is always on screen. */}
      {showTabCount && tabsOpen && (
        <div ref={tabsMenuRef} id={TABS_MENU_ID} role="menu" aria-label="Open tabs" onKeyDown={onTabsMenuKeyDown}
          className="ui-popover absolute inset-x-4 top-full z-100 mt-1 max-h-[60vh] overflow-y-auto p-1">
          {tabs.map(open => (
            <button key={open.path} role="menuitemradio" aria-checked={open.path === activeTab} tabIndex={-1}
              onClick={() => selectTab(open.path)}
              className={'flex w-full cursor-pointer items-center gap-2 rounded border-none px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-active ' + (open.path === activeTab ? 'bg-surface-active text-foreground' : 'bg-transparent text-foreground-secondary')}>
              <span className={'min-w-0 flex-1 truncate ' + (open.deleted ? 'line-through opacity-50' : '')}>{open.name}</span>
              {open.path === activeTab && <Check size={13} aria-hidden="true" className="shrink-0 text-accent" />}
            </button>
          ))}
        </div>
      )}

      <span className="relative shrink-0" ref={actionsRef}>
        <button onClick={toggleActions} aria-label="More actions" title="More actions" aria-expanded={actionsOpen}
          className={compactTrigger
            ? 'rounded cursor-pointer text-xs flex items-center gap-1 text-foreground-subtle hover:text-foreground hover:bg-surface-active p-2'
            : 'flex items-center justify-center min-w-10 sm:min-w-8 p-2 rounded-md border border-border-subtle bg-background cursor-pointer text-foreground-subtle hover:text-foreground-secondary hover:bg-surface-active'}>
          {compactTrigger
            ? <>Actions <ChevronDown size={12} className={'transition-transform ' + (actionsOpen ? 'rotate-180' : '')} /></>
            : <Share size={15} />}
        </button>
        {actionsOpen && <EditorActionsMenu actions={actions} />}
      </span>
    </TopBarShell>
  )
}
