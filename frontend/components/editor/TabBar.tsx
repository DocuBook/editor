import { useEffect, useRef, useState } from 'react'
import { X, Undo2, Redo2, Sparkles, Command, Option, ChevronUp, ArrowBigUp, PanelLeft } from 'lucide-react'
import { useEditorStore } from '../../stores/editor'
import { useGitStatus } from '../../stores/gitStatus'
import { invoke } from '../../lib/ipc'
import { toast } from 'sonner'
import { editorFileKind } from '../../utils/fileKind'

export function TabBar({ onAiToggle, sidebarOpen, onToggleSidebar }: { onAiToggle: () => void; sidebarOpen: boolean; onToggleSidebar: () => void }) {
  const { undo, redo, canUndo, canRedo } = useEditorStore()
  const { activeTab, tabs, switchTab, closeTab, editMode } = useEditorStore()
  const [pubState, setPubState] = useState<'idle'|'committing'|'pushing'|'done'|'error'>('idle')
  const [pubMsg, setPubMsg] = useState('')
  const [staged, setStaged] = useState(false)
  const [hasDiskChanges, setHasDiskChanges] = useState(false)
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
  const { isRepo, hasRemote, status: gitStatus } = useGitStatus()
  useEffect(() => {
    const lines = gitStatus.trim() ? gitStatus.split('\n').filter((l: string) => l.trim()) : []
    const curFile = useEditorStore.getState().activeTab
    const relevant = curFile ? lines.filter((l: string) => l.length > 3 && l.substring(3).trim() === curFile) : lines
    setHasDiskChanges(relevant.some((l: string) => l.length > 1 && l[1] !== ' '))
    if (lines.length === 0 || !lines.some((l: string) => l[0] !== ' ' && l[0] !== '?')) setStaged(false)
  }, [gitStatus])

  const publish = async () => {
    setPubState('committing')
    try {
      const rawName = tabs.find(t => t.path === activeTab)?.name || 'changes'
      /** Sanitize the filename for use in a git commit message: strip control
       *  characters, newlines, and trailing dots (Windows-invalid). */
      const msg = `Auto-commit: ${Array.from(rawName).filter(char => { const code = char.charCodeAt(0); return code > 0x1f && code !== 0x7f }).join('').replace(/\.+$/g, '').trim() || 'changes'}`
      const res = await invoke<string>('git_push', { message: msg })
      const d = JSON.parse(res)
      if (d.error && d.error !== 'Nothing to push') { setPubMsg(d.error); setPubState('error'); setStaged(false) }
      else {
        setPubMsg(d.commit ? d.commit.substring(0, 7) : 'synced')
        setPubState(d.success ? 'done' : 'idle')
        setStaged(false)
        if (d.message === 'Nothing to push') setPubState('idle')
      }
    } catch { setPubState('error') }
  }

  return (
    <div className="ui-shell h-12 bg-surface border-b border-border-subtle flex items-center gap-3 shrink-0 text-xs px-6">
      <span className="tip-wrap tip-bar tip-bar-left">
        <button
          onClick={onToggleSidebar}
          aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          aria-expanded={sidebarOpen}
          className="rounded cursor-pointer text-zinc-500 hover:text-foreground-secondary hover:bg-surface-active p-2"
        >
          {sidebarOpen ? <PanelLeft size={16} /> : <PanelLeft size={16} />}
        </button>
        <span className="tip">{sidebarOpen ? 'Collapse' : 'Expand'} sidebar <kbd><Command size={11} />J</kbd></span>
      </span>
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
      <span className="tip-wrap tip-bar">
        <button onClick={async () => {
          const s = useEditorStore.getState()
          s.flushEditor() /** sync WYSIWYG → editedContent */
          const s2 = useEditorStore.getState() /** fresh state after flush */
          const tab = s2.tabs.find(t => t.path === s2.activeTab)
          if (tab?.deleted) return
          try {
            if (tab && s2.activeTab) {
              const src = tab.content ?? ''
              const content = tab.frontmatter + (tab.editedContent ?? src.replace(tab.frontmatter, ''))
              await invoke('write_file', { path: s2.activeTab, content })
            }
            await invoke('git_stage'); setStaged(true); useEditorStore.getState().setTabDirty(s2.activeTab!, false); setHasDiskChanges(false)
          } catch(e) { console.error('Save:', e); toast.error('Failed to save') }
        }}
        disabled={!isRepo || !(hasDiskChanges || hasUnsaved) || file?.deleted}
        className="rounded cursor-pointer text-xs text-foreground-subtle hover:text-foreground hover:bg-surface-active disabled:opacity-30 disabled:cursor-not-allowed p-2">Save</button>
        <span className="tip">{!isRepo ? "Initialize Git in Settings first" : "Stage changes"}</span>
      </span>
      <span className="tip-wrap tip-bar">
        <button onClick={publish} disabled={!isRepo || !hasRemote || !staged || pubState === 'committing' || pubState === 'pushing'}
        className={'rounded cursor-pointer text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed p-2 ' + ({ idle: 'bg-blue-600 text-white hover:bg-blue-500', committing: 'bg-yellow-600 text-white', pushing: 'bg-yellow-600 text-white', done: 'bg-green-600 text-white', error: 'bg-red-600 text-white' }[pubState] || 'bg-blue-600 text-white')}>
        {pubState === 'idle' && <>Publish</>}{pubState === 'committing' && <>Commit...</>}{pubState === 'pushing' && <>Push...</>}{pubState === 'done' && <>{pubMsg} ✓</>}{pubState === 'error' && <>Failed</>}
        </button>
        <span className="tip">{!isRepo ? "Initialize Git in Settings first" : !hasRemote ? "Add a Git remote in Settings first" : "Git commit + push"}</span>
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
