import { useEffect, useRef, useState, type RefObject } from 'react'
import { X, ChevronLeft, ChevronRight, Command, ArrowBigUp, PanelLeft, ChevronDown, GitCommitHorizontal, Upload, Search } from 'lucide-react'
import { BsMarkdown } from 'react-icons/bs'
import { TbBlocks } from 'react-icons/tb'
import { useEditorStore } from '../../stores/editor'
import { useGitStatus } from '../../stores/gitStatus'
import { invoke, isMacTauri, isTauri } from '../../lib/ipc'
import { toast } from 'sonner'
import { editorFileKind } from '../../utils/fileKind'
import { useClickOutside } from '../../hooks/useClickOutside'


/** Sanitize a filename for use in a git commit message: strip control
 *  characters, newlines, and trailing dots (Windows-invalid). */
const sanitizeCommitName = (rawName: string) =>
  Array.from(rawName)
    .filter(char => { const code = char.charCodeAt(0); return code > 0x1f && code !== 0x7f })
    .join('')
    .replace(/\.+$/g, '')
    .trim() || 'changes'

export function TabBar({ sidebarOpen, isDesktop, sidebarToggleRef, onToggleSidebar, onOpenSearch }: { sidebarOpen: boolean; isDesktop: boolean; sidebarToggleRef: RefObject<HTMLButtonElement | null>; onToggleSidebar: () => void; onOpenSearch: () => void }) {
  const { undo, redo, canUndo, canRedo } = useEditorStore()
  const { activeTab, tabs, switchTab, closeTab, editMode } = useEditorStore()
  const [hasDiskChanges, setHasDiskChanges] = useState(false)
  /** Actions dropdown (Commit / Push) — one state machine per action.
   *  'busy' guards double-clicks; 'done' auto-resets to 'idle' (below). */
  const [actionsOpen, setActionsOpen] = useState(false)

  const [commitState, setCommitState] = useState<'idle'|'busy'|'done'|'error'>('idle')
  const [pushState, setPushState] = useState<'idle'|'busy'|'done'|'error'>('idle')
  const [gitMsg, setGitMsg] = useState<{ commit: string; push: string }>({ commit: '', push: '' })
  const actionsRef = useRef<HTMLSpanElement>(null)
  useClickOutside(actionsRef, () => setActionsOpen(false))
  const file = useEditorStore(s => s.tabs.find(t => t.path === s.activeTab))
  const hasUnsaved = file?.dirty ?? false
  /** Compact web (<640px, Docker/web only — native macOS untouched):
   *  single row keeps [panel|search] + tabs + Actions; undo/redo + mode
   *  toggle move into the Actions menu. JS conditional (not CSS hidden)
   *  so WKWebView is never affected. Reuses isDesktop prop — no new MQ. */
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
  useEffect(() => {
    /** Reset disk-dirty on tab switch; next git poll corrects it */
    setHasDiskChanges(false)
  }, [curTab])

  /** Git status: shared store (single poller from App root) — derive per-tab state. */
  const { isRepo, hasRemote, ahead, upstream, status: gitStatus } = useGitStatus()

  useEffect(() => {
    const lines = gitStatus.trim() ? gitStatus.split('\n').filter((l: string) => l.trim()) : []
    const curFile = useEditorStore.getState().activeTab
    const relevant = curFile ? lines.filter((l: string) => l.length > 3 && l.substring(3).trim() === curFile) : lines
    setHasDiskChanges(relevant.some((l: string) => l.length > 1 && l[1] !== ' '))
  }, [gitStatus])

  /** A successful Commit/Push indicator auto-resets to idle after 3s, so the
   *  menu does not stay green forever after a one-shot action. */
  useEffect(() => {
    if (commitState !== 'done' && pushState !== 'done') return
    const t = setTimeout(() => {
      setCommitState(x => (x === 'done' ? 'idle' : x))
      setPushState(x => (x === 'done' ? 'idle' : x))
    }, 3000)
    return () => clearTimeout(t)
  }, [commitState, pushState])

  const commit = async () => {
    if (commitState === 'busy') return
    setCommitState('busy')
    try {
      /** Commit ships the working tree — NO save here. Persisting to disk is an
       *  app-layer concern (mode switch, close tab, app close); the button is
       *  disabled while a tab is unsaved so we never commit stale content. */
      await invoke('git_stage')
      const rawName = tabs.find(t => t.path === activeTab)?.name || 'changes'
      const res = await invoke<string>('git_commit', { message: `Auto-commit: ${sanitizeCommitName(rawName)}` })
      const d = JSON.parse(res)
      if (d.error) { setGitMsg(p => ({ ...p, commit: d.error })); setCommitState('error'); return }
      if (d.message === 'Nothing to commit') { setCommitState('idle'); setGitMsg(p => ({ ...p, commit: '' })); toast.info('Nothing to commit'); return }
      setGitMsg(p => ({ ...p, commit: d.commit ? d.commit.substring(0, 7) : 'committed' }))
      setCommitState('done')
    } catch { setGitMsg(p => ({ ...p, commit: 'Commit failed' })); setCommitState('error') }
  }

  const push = async () => {
    if (pushState === 'busy') return
    setPushState('busy')
    try {
      const res = await invoke<string>('git_push_only')
      const d = JSON.parse(res)
      if (d.error) { setGitMsg(p => ({ ...p, push: d.error })); setPushState('error'); return }
      if (d.message === 'Nothing to push') { setPushState('idle'); setGitMsg(p => ({ ...p, push: '' })); toast.info('Nothing to push'); return }
      setGitMsg(p => ({ ...p, push: 'Pushed ✓' }))
      setPushState('done')
    } catch { setGitMsg(p => ({ ...p, push: 'Push failed' })); setPushState('error') }
  }

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
        <span className="tip-wrap tip-bar">
          <button onClick={() => undo()} disabled={!canUndo} className="rounded cursor-pointer text-foreground-subtle hover:text-foreground-secondary hover:bg-surface-active disabled:opacity-30 disabled:cursor-not-allowed min-w-10 sm:min-w-8 p-2 flex items-center justify-center"><ChevronLeft size={16} /></button>
          <span className="tip">Undo <kbd><Command size={11} />Z</kbd></span>
        </span>
        <span className="tip-wrap tip-bar border-l border-border-subtle">
          <button onClick={() => redo()} disabled={!canRedo} className="rounded cursor-pointer text-foreground-subtle hover:text-foreground-secondary hover:bg-surface-active disabled:opacity-30 disabled:cursor-not-allowed min-w-10 sm:min-w-8 p-2 flex items-center justify-center"><ChevronRight size={16} /></button>
          <span className="tip">Redo <kbd><Command size={11} /><ArrowBigUp size={11} />Z</kbd></span>
        </span>
      </span>
      )}
      <div ref={tabStripRef} className={'flex-1 min-w-0 flex items-stretch h-full overflow-y-hidden scrollbar-none ' + (compact ? 'overflow-hidden' : 'overflow-x-auto')}>
        {tabs.length === 0 ? <span className="text-foreground-subtle italic self-center">No file open</span> : visibleTabs.map(tab => (
          <div key={tab.path} data-tab-path={tab.path} onClick={() => switchTab(tab.path)}
            className={'tab-item flex items-center justify-center relative cursor-pointer ' + (compact ? 'flex-1 min-w-0 pl-6 pr-8 ' : 'whitespace-nowrap shrink-0 px-8 border-r border-border-subtle ') + (activeTab === tab.path ? 'tab-active bg-background text-foreground' : 'tab-inactive text-foreground-subtle')}>
            {activeTab === tab.path && <span data-testid="active-tab-indicator" aria-hidden="true" className={'absolute size-1.5 rounded-full bg-accent ' + (compact ? 'left-2' : 'left-3')} />}
            <span title={compact ? tab.name : undefined} className={(compact ? 'min-w-0 truncate ' : '') + (tab.deleted ? 'line-through opacity-50' : '')}>{tab.name}</span>
            {activeTab === tab.path && (
              <button onClick={e => { e.stopPropagation(); closeTab(tab.path) }} style={compact ? { opacity: 1 } : undefined} className="tab-close-btn absolute right-1 border-none bg-transparent cursor-pointer p-1 rounded text-foreground-subtle transition-opacity"><X size={14} /></button>
            )}
          </div>
        ))}
      </div>

      {showInlineEditing && (
      <span className="tip-wrap tip-bar shrink-0">
        <span className="inline-flex items-center rounded-md border border-border-subtle bg-background overflow-hidden">
          <button onClick={() => { if (editMode !== 'code') useEditorStore.getState().toggleEditMode() }} disabled={!toggleable} aria-label="Markdown mode"
          className={'flex items-center justify-center min-w-10 sm:min-w-8 p-2 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer ' + (editMode === 'code' ? 'bg-surface-active text-foreground' : 'bg-transparent text-foreground-subtle hover:text-foreground-secondary hover:bg-surface-active')}
          ><BsMarkdown size={15} /></button>
          <button onClick={() => { if (editMode !== 'editor') useEditorStore.getState().toggleEditMode() }} disabled={!toggleable} aria-label="Editor (WYSIWYG) mode"
          className={'flex items-center justify-center min-w-10 sm:min-w-8 p-2 border-l border-border-subtle disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer ' + (editMode === 'editor' ? 'bg-surface-active text-foreground' : 'bg-transparent text-foreground-subtle hover:text-foreground-secondary hover:bg-surface-active')}
          ><TbBlocks size={15} /></button>
        </span>
        <span className="tip">{tabs.length === 0 ? 'Open a file first' : toggleable ? 'Switch mode to ' + (editMode === 'editor' ? 'markdown' : 'editor') : 'Preview only'} <kbd><Command size={11} /><ArrowBigUp size={11} />E</kbd></span>
      </span>
      )}

      <span className="relative shrink-0" ref={actionsRef}>
        <button onClick={() => setActionsOpen(o => !o)} aria-label="Git actions" aria-expanded={actionsOpen}
          className="rounded cursor-pointer text-xs flex items-center gap-1 text-foreground-subtle hover:text-foreground hover:bg-surface-active p-2">
          Actions <ChevronDown size={12} className={'transition-transform ' + (actionsOpen ? 'rotate-180' : '')} />
        </button>
        {actionsOpen && (
          <div className="absolute top-full right-0 mt-1 bg-surface border border-border rounded-lg p-1 min-w-[200px] z-50 shadow-[0_4px_12px_var(--color-shadow)]">
            {compact && (
              <>
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
                <div className="border-t border-border-subtle my-1" />
              </>
            )}
            <button onClick={commit} disabled={!isRepo || hasUnsaved || !hasDiskChanges || commitState === 'busy'}
              className="flex items-center gap-2 w-full px-2.5 py-1.5 cursor-pointer text-[13px] bg-transparent border-none rounded hover:bg-surface-active disabled:opacity-40 disabled:cursor-not-allowed text-left">
              <span className={commitState === 'done' ? 'text-success shrink-0' : commitState === 'error' ? 'text-danger shrink-0' : 'text-foreground-secondary shrink-0'}><GitCommitHorizontal size={14} /></span>
              <span>{commitState === 'busy' ? 'Committing…' : commitState === 'done' ? `Committed ${gitMsg.commit}` : commitState === 'error' ? 'Commit failed' : 'Commit'}</span>
            </button>
            {commitState === 'error' && gitMsg.commit && <div className="px-2.5 pb-1.5 text-[10px] text-danger break-words max-w-[220px]">{gitMsg.commit}</div>}
            {hasUnsaved && isRepo && <div className="px-2.5 pb-1.5 text-[10px] text-muted">Unsaved changes — switch mode or close the tab to save first</div>}
            <button onClick={push} disabled={!isRepo || !hasRemote || (!!upstream && ahead <= 0) || pushState === 'busy'}
              className="flex items-center gap-2 w-full px-2.5 py-1.5 cursor-pointer text-[13px] bg-transparent border-none rounded hover:bg-surface-active disabled:opacity-40 disabled:cursor-not-allowed text-left">
              <span className={pushState === 'done' ? 'text-success shrink-0' : pushState === 'error' ? 'text-danger shrink-0' : 'text-foreground-secondary shrink-0'}><Upload size={14} /></span>
              <span>{pushState === 'busy' ? 'Pushing…' : pushState === 'done' ? 'Pushed ✓' : pushState === 'error' ? 'Push failed' : 'Push'}</span>
              {upstream && ahead > 0 && <span className="ml-auto text-[10px] text-muted">↑{ahead}</span>}
              {!upstream && hasRemote && <span className="ml-auto text-[10px] text-muted">new branch</span>}
            </button>
            {pushState === 'error' && gitMsg.push && <div className="px-2.5 pb-1.5 text-[10px] text-danger break-words max-w-[220px]">{gitMsg.push}</div>}
          </div>
        )}
      </span>
    </div>
  )
}
