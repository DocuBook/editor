import { useEffect, useRef, useState, type RefObject } from 'react'
import { X, ChevronDown, ChevronLeft, ChevronRight, Share } from 'lucide-react'
import { toast } from 'sonner'
import { useEditorStore } from '../../stores/editor'
import { invoke, isMacTauri, isTauri } from '../../lib/ipc'
import { editorFileKind } from '../../utils/fileKind'
import { useClickOutside } from '../../hooks/useClickOutside'
import { SidebarToggle } from '../SidebarToggle'
import { TopBarShell } from '../TopBarShell'
import { EditorActionsMenu } from './editorActions'
import { buildEditorActions, type EditorApp } from './editorActionItems'

export function TabBar({ sidebarOpen, isDesktop, sidebarToggleRef, onToggleSidebar, onOpenSearch }: { sidebarOpen: boolean; isDesktop: boolean; sidebarToggleRef: RefObject<HTMLButtonElement | null>; onToggleSidebar: () => void; onOpenSearch: () => void }) {
  const { undo, redo, canUndo, canRedo } = useEditorStore()
  const { activeTab, tabs, switchTab, closeTab, editMode } = useEditorStore()
  const [actionsOpen, setActionsOpen] = useState(false)
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
          <div key={tab.path} data-tab-path={tab.path} onClick={() => switchTab(tab.path)}
            className={'tab-item flex items-center justify-center relative cursor-pointer ' + (compact ? 'flex-1 min-w-0 pl-4 pr-8 ' : 'whitespace-nowrap shrink-0 px-8 ') + (activeTab === tab.path ? 'tab-active text-foreground' : 'tab-inactive text-foreground-subtle')}>
            <span title={compact ? tab.name : undefined} className={(compact ? 'min-w-0 truncate ' : '') + (tab.deleted ? 'line-through opacity-50' : '')}>{tab.name}</span>
            <button onClick={e => { e.stopPropagation(); closeTab(tab.path) }} aria-label={'Close ' + tab.name} style={compact ? { opacity: 1, pointerEvents: 'auto' } : undefined} className="tab-close-btn absolute right-1 border-none bg-transparent cursor-pointer p-1 rounded text-foreground-subtle transition-opacity"><X size={14} /></button>
          </div>
        ))}
      </div>

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
