import { useEffect, useRef, useState, type RefObject } from 'react'
import { X, ChevronLeft, ChevronRight, PanelLeft, ChevronDown, Search } from 'lucide-react'
import { BsMarkdown } from 'react-icons/bs'
import { TbBlocks } from 'react-icons/tb'
import { useEditorStore } from '../../stores/editor'
import { isMacTauri, isTauri } from '../../lib/ipc'
import { editorFileKind } from '../../utils/fileKind'
import { useClickOutside } from '../../hooks/useClickOutside'

export function TabBar({ sidebarOpen, isDesktop, sidebarToggleRef, onToggleSidebar, onOpenSearch }: { sidebarOpen: boolean; isDesktop: boolean; sidebarToggleRef: RefObject<HTMLButtonElement | null>; onToggleSidebar: () => void; onOpenSearch: () => void }) {
  const { undo, redo, canUndo, canRedo } = useEditorStore()
  const { activeTab, tabs, switchTab, closeTab, editMode } = useEditorStore()
  const [actionsOpen, setActionsOpen] = useState(false)
  const actionsRef = useRef<HTMLSpanElement>(null)
  useClickOutside(actionsRef, () => setActionsOpen(false))
  const file = useEditorStore(s => s.tabs.find(t => t.path === s.activeTab))
  /** Compact web (<640px, Docker/web only — native macOS untouched):
   *  single row keeps [panel|search] + tabs + Actions; undo/redo + mode
   *  toggle move into the Actions menu. Git actions live in Changes. */
  const compact = !isTauri && !isDesktop
  const showInlineEditing = !compact
  const visibleTabs = compact ? tabs.filter(tab => tab.path === activeTab) : tabs
  const closeActions = () => setActionsOpen(false)
  /** Only .md files can toggle Editor ↔ Code; others are preview. */
  const toggleable = file ? editorFileKind(file.path) === 'wysiwyg' : false

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
    <div data-tauri-drag-region={isMacTauri ? true : undefined} className={'editor-tab-bar ui-shell relative z-30 h-12 flex items-center flex-nowrap shrink-0 text-xs ' + (compact ? 'gap-2 pl-4 pr-4 ' : 'gap-3 pr-6 ') + (!compact && isMacTauri && !sidebarOpen ? 'pl-20' : !compact ? 'pl-6' : '')}>
      <span className={'inline-flex shrink-0 items-center ' + (sidebarOpen ? '' : 'rounded-md border border-border-subtle bg-background overflow-hidden')}>
        <button
          ref={sidebarToggleRef}
          data-testid="sidebar-toggle"
          onClick={onToggleSidebar}
          aria-label={isDesktop ? (sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar') : (sidebarOpen ? 'Close sidebar drawer' : 'Open sidebar drawer')}
          aria-expanded={sidebarOpen}
          aria-controls={isDesktop ? 'desktop-sidebar' : 'mobile-sidebar'}
          aria-haspopup={isDesktop ? undefined : 'dialog'}
          className="rounded cursor-pointer text-foreground-subtle hover:text-foreground-secondary hover:bg-surface-active p-2"
        >
          <PanelLeft size={16} />
        </button>
        {!sidebarOpen && (
          <button
            onClick={onOpenSearch}
            aria-label="Search files"
            className="cursor-pointer text-foreground-subtle hover:text-foreground-secondary hover:bg-surface-active p-2 border-l border-border-subtle"
          >
            <Search size={16} />
          </button>
        )}
      </span>
      {showInlineEditing && (
      <span className="inline-flex shrink-0 items-center rounded-md border border-border-subtle bg-background">
        <button onClick={() => undo()} disabled={!canUndo} title="Undo" aria-label="Undo" className="rounded cursor-pointer text-foreground-subtle hover:text-foreground-secondary hover:bg-surface-active disabled:opacity-30 disabled:cursor-not-allowed min-w-10 sm:min-w-8 p-2 flex items-center justify-center"><ChevronLeft size={16} /></button>
        <button onClick={() => redo()} disabled={!canRedo} title="Redo" aria-label="Redo" className="rounded cursor-pointer text-foreground-subtle hover:text-foreground-secondary hover:bg-surface-active disabled:opacity-30 disabled:cursor-not-allowed min-w-10 sm:min-w-8 p-2 border-l border-border-subtle flex items-center justify-center"><ChevronRight size={16} /></button>
      </span>
      )}
      <div ref={tabStripRef} className={'tab-strip flex-1 min-w-0 flex items-stretch h-full overflow-y-hidden scrollbar-none ' + (compact ? 'overflow-hidden' : 'overflow-x-auto')}>
        {tabs.length === 0 ? <span className="text-foreground-subtle italic self-center">No file open</span> : visibleTabs.map(tab => (
          <div key={tab.path} data-tab-path={tab.path} onClick={() => switchTab(tab.path)}
            className={'tab-item flex items-center justify-center relative cursor-pointer ' + (compact ? 'flex-1 min-w-0 pl-6 pr-8 ' : 'whitespace-nowrap shrink-0 px-8 ') + (activeTab === tab.path ? 'tab-active bg-background text-foreground' : 'tab-inactive text-foreground-subtle')}>
            {activeTab === tab.path && <span data-testid="active-tab-indicator" aria-hidden="true" className={'absolute size-1.5 rounded-full bg-accent ' + (compact ? 'left-2' : 'left-3')} />}
            <span title={compact ? tab.name : undefined} className={(compact ? 'min-w-0 truncate ' : '') + (tab.deleted ? 'line-through opacity-50' : '')}>{tab.name}</span>
            {activeTab === tab.path && (
              <button onClick={e => { e.stopPropagation(); closeTab(tab.path) }} style={compact ? { opacity: 1 } : undefined} className="tab-close-btn absolute right-1 border-none bg-transparent cursor-pointer p-1 rounded text-foreground-subtle transition-opacity"><X size={14} /></button>
            )}
          </div>
        ))}
      </div>

      {showInlineEditing && (
      <span className="inline-flex shrink-0 items-center rounded-md border border-border-subtle bg-background overflow-hidden">
        <button onClick={() => { if (editMode !== 'code') useEditorStore.getState().toggleEditMode() }} disabled={!toggleable} aria-label="Markdown mode" title="Markdown mode"
        className={'flex items-center justify-center min-w-10 sm:min-w-8 p-2 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer ' + (editMode === 'code' ? 'bg-surface-active text-foreground' : 'bg-transparent text-foreground-subtle hover:text-foreground-secondary hover:bg-surface-active')}
        ><BsMarkdown size={15} /></button>
        <button onClick={() => { if (editMode !== 'editor') useEditorStore.getState().toggleEditMode() }} disabled={!toggleable} aria-label="Editor (WYSIWYG) mode" title="Editor (WYSIWYG) mode"
        className={'flex items-center justify-center min-w-10 sm:min-w-8 p-2 border-l border-border-subtle disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer ' + (editMode === 'editor' ? 'bg-surface-active text-foreground' : 'bg-transparent text-foreground-subtle hover:text-foreground-secondary hover:bg-surface-active')}
        ><TbBlocks size={15} /></button>
      </span>
      )}

      {compact && (
        <span className="relative shrink-0" ref={actionsRef}>
          <button onClick={() => setActionsOpen(o => !o)} aria-label="Editor actions" aria-expanded={actionsOpen}
            className="rounded cursor-pointer text-xs flex items-center gap-1 text-foreground-subtle hover:text-foreground hover:bg-surface-active p-2">
            Actions <ChevronDown size={12} className={'transition-transform ' + (actionsOpen ? 'rotate-180' : '')} />
          </button>
          {actionsOpen && (
            <div className="ui-popover absolute top-full right-0 mt-1 min-w-50 p-1 z-50">
              <button onClick={() => undo()} disabled={!canUndo}
                className="flex items-center gap-2 w-full px-2.5 py-1.5 cursor-pointer text-[13px] bg-transparent border-none rounded hover:bg-surface-active disabled:opacity-40 disabled:cursor-not-allowed text-left">
                <span className="text-foreground-secondary shrink-0"><ChevronLeft size={14} /></span>
                <span>Undo</span>
              </button>
              <button onClick={() => redo()} disabled={!canRedo}
                className="flex items-center gap-2 w-full px-2.5 py-1.5 cursor-pointer text-[13px] bg-transparent border-none rounded hover:bg-surface-active disabled:opacity-40 disabled:cursor-not-allowed text-left">
                <span className="text-foreground-secondary shrink-0"><ChevronRight size={14} /></span>
                <span>Redo</span>
              </button>
              <button onClick={() => { useEditorStore.getState().toggleEditMode(); closeActions() }} disabled={!toggleable}
                className="flex items-center gap-2 w-full px-2.5 py-1.5 cursor-pointer text-[13px] bg-transparent border-none rounded hover:bg-surface-active disabled:opacity-40 disabled:cursor-not-allowed text-left">
                <span className="text-foreground-secondary shrink-0">{editMode === 'editor' ? <BsMarkdown size={14} /> : <TbBlocks size={14} />}</span>
                <span>{tabs.length === 0 ? 'No file to switch' : toggleable ? 'Switch to ' + (editMode === 'editor' ? 'markdown' : 'editor') : 'Preview only'}</span>
              </button>
            </div>
          )}
        </span>
      )}
    </div>
  )
}
