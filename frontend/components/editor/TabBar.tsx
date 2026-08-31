import { useEffect, useRef, useState } from 'react'
import { X, Undo2, Redo2, Sparkles, Command, Option, ChevronUp, ArrowBigUp, PanelLeft, ChevronDown, GitCommitHorizontal, Upload, Search } from 'lucide-react'
import { useEditorStore } from '../../stores/editor'
import { useGitStatus } from '../../stores/gitStatus'
import { invoke } from '../../lib/ipc'
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

export function TabBar({ onAiToggle, sidebarOpen, onToggleSidebar, onOpenSearch }: { onAiToggle: () => void; sidebarOpen: boolean; onToggleSidebar: () => void; onOpenSearch: () => void }) {
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
  /** Only .md files can toggle Editor ↔ Code; others are preview. */
  const toggleable = file ? editorFileKind(file.path) === 'wysiwyg' : false
  /** AI available only in Editor (WYSIWYG) mode — BlockNote must be mounted. */
  const aiAvailable = file ? editorFileKind(file.path) === 'wysiwyg' && editMode === 'editor' : false

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
    <div className="ui-shell h-12 bg-surface border-b border-border-subtle flex items-center gap-3 shrink-0 text-xs px-6">
      {sidebarOpen ? (
        <button
          onClick={onToggleSidebar}
          aria-label="Collapse sidebar"
          aria-expanded={sidebarOpen}
          className="rounded cursor-pointer text-zinc-500 hover:text-foreground-secondary hover:bg-surface-active p-2"
        >
          <PanelLeft size={16} />
        </button>
      ) : (
        /** Collapsed sidebar → the toggle becomes a compact icon group with a
         *  search trigger beside it (fumadocs rail pattern) — same actions,
         *  one shell. */
        <span className="inline-flex items-center rounded-md border border-border-subtle bg-background overflow-hidden">
          <button
            onClick={onToggleSidebar}
            aria-label="Expand sidebar"
            aria-expanded={sidebarOpen}
            className="cursor-pointer text-zinc-500 hover:text-foreground-secondary hover:bg-surface-active p-2"
          >
            <PanelLeft size={16} />
          </button>
          <button
            onClick={onOpenSearch}
            aria-label="Search files"
            className="cursor-pointer text-zinc-500 hover:text-foreground-secondary hover:bg-surface-active p-2 border-l border-border-subtle"
          >
            <Search size={16} />
          </button>
        </span>
      )}
      <span className="tip-wrap tip-bar">
        <button onClick={() => undo()} disabled={!canUndo} className="rounded cursor-pointer text-zinc-500 hover:text-foreground-secondary hover:bg-surface-active disabled:opacity-30 disabled:cursor-not-allowed p-2"><Undo2 size={16} /></button>
        <span className="tip">Undo <kbd><Command size={11} />Z</kbd></span>
      </span>
      <span className="tip-wrap tip-bar">
        <button onClick={() => redo()} disabled={!canRedo} className="rounded cursor-pointer text-zinc-500 hover:text-foreground-secondary hover:bg-surface-active disabled:opacity-30 disabled:cursor-not-allowed p-2"><Redo2 size={16} /></button>
        <span className="tip">Redo <kbd><Command size={11} /><ArrowBigUp size={11} />Z</kbd></span>
      </span>
      <div ref={tabStripRef} className="flex-1 flex items-stretch h-full overflow-x-auto overflow-y-hidden scrollbar-none">
        {tabs.length === 0 ? <span className="text-zinc-500 italic self-center">No file open</span> : tabs.map(tab => (
          <div key={tab.path} data-tab-path={tab.path} onClick={() => switchTab(tab.path)}
            className={'tab-item flex items-center justify-center relative px-8 cursor-pointer border-r border-border-subtle whitespace-nowrap shrink-0 ' + (activeTab === tab.path ? 'tab-active bg-background text-foreground shadow-[inset_0_-1px_0_var(--color-accent)]' : 'tab-inactive text-foreground-subtle')}>
            <span className={tab.deleted ? 'line-through opacity-50' : undefined}>{tab.name}</span>
            {activeTab === tab.path && (
              <button onClick={e => { e.stopPropagation(); closeTab(tab.path) }} className="tab-close-btn absolute right-2 border-none bg-transparent cursor-pointer p-1 rounded text-foreground-subtle transition-opacity"><X size={14} /></button>
            )}
          </div>
        ))}
      </div>
      <span className="tip-wrap tip-bar">
        <button onClick={onAiToggle} disabled={!aiAvailable}
        className="rounded text-xs flex items-center gap-1 disabled:opacity-30 disabled:cursor-not-allowed enabled:cursor-pointer enabled:text-foreground-subtle enabled:hover:text-foreground enabled:hover:bg-surface-active p-2"><Sparkles size={14} /></button>
        <span className="tip">{!file ? 'Open a file first' : !aiAvailable && editorFileKind(file.path) === 'wysiwyg' ? 'Switch to Editor for AI' : aiAvailable ? 'Ask AI / Write with AI' : 'AI works on .md files'} <kbd><ChevronUp size={10} /><Option size={10} />L</kbd></span>
      </span>
      <span className="tip-wrap tip-bar">
        <button onClick={() => useEditorStore.getState().toggleEditMode()} disabled={!toggleable}
        className={'rounded text-xs p-2 disabled:opacity-30 disabled:cursor-not-allowed enabled:cursor-pointer ' + (editMode === 'code' ? 'bg-zinc-700 text-white' : 'enabled:text-zinc-500 enabled:hover:text-foreground-secondary enabled:hover:bg-surface-active')}
        >{editMode === 'editor' ? 'Markdown' : 'Editor'}</button>
        <span className="tip">{tabs.length === 0 ? 'Open a file first' : toggleable ? 'Switch mode to ' + (editMode === 'editor' ? 'markdown' : 'editor') : 'Preview only'} <kbd><Command size={11} /><ArrowBigUp size={11} />E</kbd></span>
      </span>
      <span className="relative" ref={actionsRef}>
        <button onClick={() => setActionsOpen(o => !o)} aria-label="Git actions" aria-expanded={actionsOpen}
          className="rounded cursor-pointer text-xs flex items-center gap-1 text-foreground-subtle hover:text-foreground hover:bg-surface-active p-2">
          Actions <ChevronDown size={12} className={'transition-transform ' + (actionsOpen ? 'rotate-180' : '')} />
        </button>
        {actionsOpen && (
          <div className="absolute top-full right-0 mt-1 bg-surface border border-border rounded-lg p-1 min-w-[200px] z-50 shadow-[0_4px_12px_rgba(0,0,0,0.3)]">
            <button onClick={commit} disabled={!isRepo || hasUnsaved || !hasDiskChanges || commitState === 'busy'}
              className="flex items-center gap-2 w-full px-2.5 py-1.5 cursor-pointer text-[13px] bg-transparent border-none rounded hover:bg-surface-active disabled:opacity-40 disabled:cursor-not-allowed text-left">
              <span className={commitState === 'done' ? 'text-green-500 shrink-0' : commitState === 'error' ? 'text-red-500 shrink-0' : 'text-foreground-secondary shrink-0'}><GitCommitHorizontal size={14} /></span>
              <span>{commitState === 'busy' ? 'Committing…' : commitState === 'done' ? `Committed ${gitMsg.commit}` : commitState === 'error' ? 'Commit failed' : 'Commit'}</span>
            </button>
            {commitState === 'error' && gitMsg.commit && <div className="px-2.5 pb-1.5 text-[10px] text-red-400 break-words max-w-[220px]">{gitMsg.commit}</div>}
            {hasUnsaved && isRepo && <div className="px-2.5 pb-1.5 text-[10px] text-muted">Unsaved changes — switch mode or close the tab to save first</div>}
            <button onClick={push} disabled={!isRepo || !hasRemote || (!!upstream && ahead <= 0) || pushState === 'busy'}
              className="flex items-center gap-2 w-full px-2.5 py-1.5 cursor-pointer text-[13px] bg-transparent border-none rounded hover:bg-surface-active disabled:opacity-40 disabled:cursor-not-allowed text-left">
              <span className={pushState === 'done' ? 'text-green-500 shrink-0' : pushState === 'error' ? 'text-red-500 shrink-0' : 'text-foreground-secondary shrink-0'}><Upload size={14} /></span>
              <span>{pushState === 'busy' ? 'Pushing…' : pushState === 'done' ? 'Pushed ✓' : pushState === 'error' ? 'Push failed' : 'Push'}</span>
              {upstream && ahead > 0 && <span className="ml-auto text-[10px] text-muted">↑{ahead}</span>}
              {!upstream && hasRemote && <span className="ml-auto text-[10px] text-muted">new branch</span>}
            </button>
            {pushState === 'error' && gitMsg.push && <div className="px-2.5 pb-1.5 text-[10px] text-red-400 break-words max-w-[220px]">{gitMsg.push}</div>}
          </div>
        )}
      </span>
    </div>
  )
}

/** ── Main layout ── */
/**
 * Classify a file into one of three tiers (single source of truth in
 * frontend/utils/fileKind.ts):
 * - 'wysiwyg' — markdown family (.md/.mdx): Editor/Code toggle + AI
 * - 'binary'  — image etc: inline preview (read-only)
 * - 'text'    — everything else readable: plain text viewer (read-only)
 */
