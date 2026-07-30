import { useEffect, useState, useRef } from 'react'
import { useCreateBlockNote, SuggestionMenuController, getDefaultReactSlashMenuItems } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/mantine/style.css'
import '@blocknote/xl-ai/style.css'
import { createHeadingBlockSpec, BlockNoteSchema, defaultBlockSpecs } from '@blocknote/core'
import { en as baseDict } from '@blocknote/core/locales'
import { AIExtension, AIMenuController, getAISlashMenuItems } from '@blocknote/xl-ai'
import { en as aiDict } from '@blocknote/xl-ai/locales'
import { X, Undo2, Redo2, Sparkles, EyeOff, Command, Option, ChevronUp, ArrowBigUp } from 'lucide-react'
import { useEditorStore } from '../stores/editor'
import { toast } from 'sonner'
import { extractMdxBlocks, restoreMdxBlocks } from '../utils/mdx'
import { useKeyboard } from '../hooks/useKeyboard'
import { usePolling } from '../hooks/usePolling'
import { PROVIDERS } from '../data/providers'
import { useAiSettings } from '../stores/aiSettings'

/** Read saved AI config from persisted store for Rust backend. */
function getAiConfig(): { provider?: string; model?: string; baseUrl?: string; apiKey?: string } {
  try {
    const { provider, model, apiKey } = useAiSettings.getState()
    if (!provider) return {}
    const p = PROVIDERS.find(x => x.id === provider)
    return { provider, model: model || undefined, baseUrl: p?.api, apiKey: apiKey || undefined }
  } catch (e) { console.error('[ai] getAiConfig error:', e); return {} }
}

// ── Non-text preview fallback ──
const BINARY_EXTENSIONS = ['.png','.jpg','.jpeg','.gif','.webp','.ico','.svg','.pdf','.mp3','.mp4','.mov','.avi','.zip','.tar','.gz','.rar','.exe','.dmg','.pkg','.bin']

/** Fallback UI for binary file types that can't be previewed as text. */
function PreviewFallback({ fileName }: { fileName: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-zinc-500 gap-3">
      <EyeOff size={32} strokeWidth={1.5} />
      <span className="text-sm"><span className="text-zinc-400">{fileName}</span> — preview only</span>
    </div>
  )
}

/** Base BlockNote schema with heading levels 1-5. */
let _schema: any = null
const getSchema = () => {
  if (!_schema) _schema = BlockNoteSchema.create({
    blockSpecs: {
      ...defaultBlockSpecs,
      heading: createHeadingBlockSpec({ levels: [1, 2, 3, 4, 5], allowToggleHeadings: false }),
    },
  })
  return _schema
}

// ── Inner content components (no container — shared scroll di Editor) ──
/** WYSIWYG block editor powered by BlockNoteJS. Loads markdown, syncs changes back. */
function WysiwygEditor({ markdown, onSync, filePath }: { markdown: string; onSync: (md: string) => void; filePath: string }) {
  const mdxRef = useRef<Map<string, string>>(new Map())
  const [clean, setClean] = useState('')
  useEffect(() => {
    const [c, b] = extractMdxBlocks(markdown)
    mdxRef.current = b
    setClean(c)
  }, [markdown])
  const editorRef = useRef<any>(null)
  const editor = useCreateBlockNote({
    schema: getSchema(),
    dictionary: { ...baseDict, ai: aiDict },
    extensions: [AIExtension({
      transport: {
        sendMessages: async ({ messages, abortSignal, body }) => {
          if (!messages.length || abortSignal?.aborted) return new ReadableStream()
          const { invoke } = await import('@tauri-apps/api/core')
          const { listen } = await import('@tauri-apps/api/event')
          const config = getAiConfig()
          const provider = PROVIDERS.find(p => p.id === config.provider)
          const modelDef = provider?.models.find(m => m.id === config.model)
          // opencode-go doesn't forward tool calls properly; force text-only for it
          const supportsTools = modelDef?.toolCall === true && config.provider !== 'opencode-go'
          const toolDefs = (body as any)?.toolDefinitions as Record<string, { description: string; inputSchema: any }> | undefined
          const tools = (supportsTools && toolDefs) ? Object.entries(toolDefs).map(([name, def]) => ({
            type: 'function',
            function: { name, description: def.description, parameters: def.inputSchema },
          })) : undefined
          const sel = editorRef.current?.getSelection()
          const selText = sel?.blocks?.length ? editorRef.current.blocksToMarkdownLossy(sel.blocks) : '';
          const stream = new ReadableStream({
            async start(controller) {
              const id = crypto.randomUUID()
              let fullText = ''
              controller.enqueue({ type: 'text-start', id })
              let closed = false
              const unsubToken = await listen<string>('ai:token', e => {
                if (abortSignal?.aborted || closed) { try { controller.close() } catch {}; return }
                fullText += e.payload
                controller.enqueue({ type: 'text-delta', delta: e.payload, id })
              })
              const toolBuffer: any[] = []
              const unsubTool = await listen<any>('ai:tool_call', e => {
                if (abortSignal?.aborted || closed) return
                toolBuffer.push(e.payload)
              })
              const unsubToolsDone = await listen('ai:tools_done', () => {})
              try {
                if (supportsTools && tools) {
                  // Full xl-ai flow: send xl-ai messages + tools
                  const cleanMessages = messages.map((m: any) => ({ role: m.role, content: (m.parts || []).map((p: any) => p.type === 'text' ? p.text : '').join('') || m.content || '' }))
                  await invoke('ask_ai', {
                    messages: JSON.stringify(cleanMessages),
                    tools: JSON.stringify(tools),
                    ...config,
                  })
                } else {
                  // Text-only: custom prompt with selected text
                  const userMsg = messages.find((m: any) => m.role === 'user')
                  const userText = (userMsg?.parts || []).map((p: any) => p.type === 'text' ? p.text : '').join('') || ''
                  const prompt = selText
                    ? `${userText}

Selected text:
"${selText}"

Respond ONLY with the requested content in Markdown format. No commentary, no questions, no explanations.`
                    : `${userText}

Respond ONLY with the requested content in Markdown format. No commentary.`
                  await invoke('ask_ai', {
                    messages: JSON.stringify([{ role: 'user', content: prompt }]),
                    ...config,
                  })
                }
                closed = true
                controller.enqueue({ type: 'text-end', id })
                // Flush buffered tool calls AFTER text-end (correct ordering)
                if (toolBuffer.length > 0) {
                  for (const tc of toolBuffer) {
                    controller.enqueue({ type: 'tool-input-available', ...tc })
                  }
                }
                // Direct insert only if no tool calls
                if (toolBuffer.length === 0 && fullText && editorRef.current) {
                  try {
                    const blocks = await editorRef.current.tryParseMarkdownToBlocks(fullText)
                    if (blocks?.length) {
                      const selection = editorRef.current.getSelection()
                      if (selection?.blocks?.length) {
                        editorRef.current.replaceBlocks(selection.blocks.map((b: any) => b.id), blocks)
                      } else {
                        editorRef.current.insertBlocks(blocks, editorRef.current.getTextCursorPosition().block, 'after')
                      }
                    } else {
                      editorRef.current.insertContent(fullText)
                    }
                  } catch { editorRef.current.insertContent(fullText) }
                }
              } catch (e) {
                try { controller.error(e) } catch {}
              } finally {
                closed = true; unsubToken(); unsubTool(); unsubToolsDone(); try { controller.close() } catch {} 
              }
            }
          })
          return stream
        },
        reconnectToStream: async () => null,
      },
      agentCursor: { name: 'DocuBook AI', color: '#3b82f6' },
    })],
  }, [markdown])
  useEffect(() => { editorRef.current = editor }, [editor])
  const { setBlockEditor, setFlushEditor } = useEditorStore()
  const onSyncRef = useRef(onSync)
  onSyncRef.current = onSync
  const markdownRef = useRef(markdown)
  markdownRef.current = markdown
  const dirtyRef = useRef(false)
  const initialLoadRef = useRef(true)

  // Track editor changes — skip initial load (filePath stable, remount on file change)
  useEffect(() => {
    // After current synchronous ops (replaceBlocks), mark initial load as done
    queueMicrotask(() => { initialLoadRef.current = false })
    const sub = editor.onChange(() => {
      if (initialLoadRef.current) return
      dirtyRef.current = true
      useEditorStore.getState().setTabDirty(filePath, true)
    })
    return () => sub()
  }, [editor])

  useEffect(() => {
    setBlockEditor(editor)
    return () => setBlockEditor(null)
  }, [editor, setBlockEditor])

  // Register flush-to-store for Save button
  useEffect(() => {
    const sync = () => {
      try {
        const md = restoreMdxBlocks(editor.blocksToMarkdownLossy(editor.document), mdxRef.current)
          .replace(/^\n+/, '')
          .replace(/\n+$/, '')
          .replace(/^(\s*)\* /gm, '$1- ')
        if (md !== markdownRef.current) onSyncRef.current(md)
      } catch {}
    }
    setFlushEditor(sync)
    return () => setFlushEditor(null)
  }, [editor, setFlushEditor])

  useEffect(() => {
    if (!clean) return
    try { const blocks = editor.tryParseMarkdownToBlocks(clean); editor.replaceBlocks(editor.document, blocks) }
    catch (e) { console.error('BlockNote load:', e); toast.error('Failed to load editor') }
  }, [editor, clean])

  useEffect(() => () => {
    if (!dirtyRef.current) return
    try {
      const md = restoreMdxBlocks(editor.blocksToMarkdownLossy(editor.document), mdxRef.current)
        .trim()
        .replace(/^\n+/, '')
        .replace(/\n+$/, '')
        .replace(/^(\s*)\* /gm, '$1- ')
      if (md !== markdownRef.current) onSyncRef.current(md)
    } catch {}
  }, [])

  return <BlockNoteView editor={editor} theme="dark" slashMenu={false}>
    <AIMenuController />
    <SuggestionMenuController triggerCharacter="/"
      getItems={async (query) => {
        const defaultItems = getDefaultReactSlashMenuItems(editor)
        const aiItems = getAISlashMenuItems(editor)
        if (!query) return [...defaultItems, ...aiItems]
        const q = query.toLowerCase()
        return [...defaultItems, ...aiItems].filter(i =>
          i.title?.toLowerCase().includes(q) ||
          (i.aliases || []).some((a: string) => a.includes(q))
        )
      }}
    />
  </BlockNoteView>
}

/** Plain text viewer for non-markdown files. */
function PlainTextViewer({ content, fileName }: { content: string; fileName: string }) {
  return (
    <>
      <div className="text-[11px] text-zinc-600 font-mono uppercase tracking-wider mb-4">{fileName}</div>
      <pre className="text-sm text-zinc-300 font-mono leading-relaxed whitespace-pre-wrap" style={{ paddingTop: 16 }}>{content}</pre>
    </>
  )
}

/** Raw markdown textarea editor (source mode). */
function MarkdownEditor({ content, onChange }: { content: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  return (
    <textarea ref={ref} value={content} onChange={e => onChange(e.target.value)}
      className="w-full min-h-full bg-transparent text-sm text-zinc-200 font-mono leading-relaxed outline-none resize-none"
      style={{ paddingTop: 16 }}
      spellCheck={false} />
  )
}

// ── Tab bar ──
/** Tab bar with file name, undo/redo, stage, publish, and AI toggle. */
function TabBar({ onAiToggle }: { onAiToggle: () => void }) {
  const { undo, redo } = useEditorStore()
  const { activeTab, tabs, switchTab, closeTab, editMode, setEditMode } = useEditorStore()
  const [pubState, setPubState] = useState<'idle'|'committing'|'pushing'|'done'|'error'>('idle')
  const [pubMsg, setPubMsg] = useState('')
  const [staged, setStaged] = useState(false)
  const [hasDiskChanges, setHasDiskChanges] = useState(false)
  const file = useEditorStore(s => s.tabs.find(t => t.path === s.activeTab))
  const hasUnsaved = file?.dirty ?? false

  // Subscribe to activeTab separately for tab-switch effect
  const curTab = useEditorStore(s => s.activeTab)

  useEffect(() => {
    // Reset disk-dirty on tab switch; next git poll corrects it
    setHasDiskChanges(false)
  }, [curTab])

  // Git status polling (every 3s)
  usePolling(() => {
    import('@tauri-apps/api/core').then(m =>
      m.invoke<string>('git_status').then(s => {
        try { const d = JSON.parse(s); const lines = d.status?.trim() ? d.status.split('\n').filter((l:string) => l.trim()) : [];
          const curFile = useEditorStore.getState().activeTab
          const relevant = curFile ? lines.filter((l:string) => l.length > 3 && l.substring(3).trim() === curFile) : lines
          setHasDiskChanges(relevant.some((l:string) => l.length > 1 && l[1] !== ' '));
          if (lines.length === 0 || !lines.some((l:string) => l[0] !== ' ' && l[0] !== '?')) setStaged(false) } catch {}
      }).catch(e => { console.error('Git status:', e); toast.error('Failed to check git status') })
    )
  }, 3000)

  const publish = async () => {
    setPubState('committing')
    try {
      const msg = `Auto-commit: ${tabs.find(t => t.path === activeTab)?.name || 'changes'}`
      const res = await (await import('@tauri-apps/api/core')).invoke<string>('git_push', { message: msg })
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
    <div className="h-12 bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)] flex items-center gap-3 shrink-0 text-xs" style={{ padding: '0 48px' }}>
      <span className="tip-wrap tip-bar">
        <button onClick={() => undo()} className="rounded cursor-pointer text-zinc-500 hover:text-zinc-300 hover:bg-[var(--bg-hover)] disabled:opacity-30" style={{ padding: '8px' }}><Undo2 size={16} /></button>
        <span className="tip">Undo <kbd><Command size={11} />Z</kbd></span>
      </span>
      <span className="tip-wrap tip-bar">
        <button onClick={() => redo()} className="rounded cursor-pointer text-zinc-500 hover:text-zinc-300 hover:bg-[var(--bg-hover)] disabled:opacity-30" style={{ padding: '8px' }}><Redo2 size={16} /></button>
        <span className="tip">Redo <kbd><Command size={11} /><ArrowBigUp size={11} />Z</kbd></span>
      </span>
      <div className="flex items-stretch h-full overflow-x-auto overflow-y-hidden scrollbar-none">
        {tabs.length === 0 ? <span className="text-zinc-500 italic self-center">No file open</span> : tabs.map(tab => (
          <div key={tab.path} onClick={() => switchTab(tab.path)}
            className={'tab-item ' + (activeTab === tab.path ? 'tab-active' : 'tab-inactive')}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', padding: '0 32px', cursor: 'pointer', borderRight: '1px solid var(--border-subtle)', whiteSpace: 'nowrap', flexShrink: 0, ...(activeTab === tab.path ? { background: 'var(--bg-primary)', color: 'var(--text-primary)', boxShadow: 'inset 0 -1px 0 var(--tab-active-border)' } : { color: '#71717a' }) }}>
            <span style={tab.deleted ? { textDecoration: 'line-through', opacity: 0.5 } : undefined}>{tab.name}</span>
            {activeTab === tab.path && (
              <button onClick={e => { e.stopPropagation(); closeTab(tab.path) }} className="tab-close-btn" style={{ position: 'absolute', right: 8, border: 'none', background: 'transparent', cursor: 'pointer', padding: 4, borderRadius: 4, color: '#71717a', transition: 'opacity 120ms ease' }}><X size={14} /></button>
            )}
          </div>
        ))}
      </div>
      <div className="flex-1" />
      <span className="tip-wrap tip-bar">
        <button onClick={onAiToggle} disabled={tabs.length === 0}
        className="rounded text-xs flex items-center gap-1 disabled:opacity-30 disabled:cursor-not-allowed enabled:cursor-pointer enabled:text-zinc-400 enabled:hover:text-zinc-200 enabled:hover:bg-[var(--bg-hover)]" style={{ padding: '8px' }}><Sparkles size={14} /></button>
        <span className="tip">{tabs.length === 0 ? 'Open a file first' : 'Ask AI / Write with AI'} <kbd><ChevronUp size={10} /><Option size={10} />L</kbd></span>
      </span>
      <span className="tip-wrap tip-bar">
        <button onClick={() => setEditMode(editMode === 'wysiwyg' ? 'markdown' : 'wysiwyg')} disabled={tabs.length === 0}
        className={'rounded text-xs disabled:opacity-30 disabled:cursor-not-allowed enabled:cursor-pointer ' + (editMode === 'markdown' ? 'bg-zinc-700 text-white' : 'enabled:text-zinc-500 enabled:hover:text-zinc-300 enabled:hover:bg-[var(--bg-hover)]')} style={{ padding: '8px' }}
        >{editMode === 'wysiwyg' ? 'Code' : 'Editor'}</button>
        <span className="tip">{tabs.length === 0 ? 'Open a file first' : 'Switch mode to ' + (editMode === 'wysiwyg' ? 'source' : 'editor')} <kbd><Command size={11} />E</kbd></span>
      </span>
      <span className="tip-wrap tip-bar">
        <button onClick={async () => {
          const s = useEditorStore.getState()
          s.flushEditor() // sync WYSIWYG → editedContent
          const s2 = useEditorStore.getState() // fresh state after flush
          const tab = s2.tabs.find(t => t.path === s2.activeTab)
          if (tab?.deleted) return
          try {
            if (tab && s2.activeTab) {
              const src = tab.content ?? ''
              const content = tab.frontmatter + (tab.editedContent ?? src.replace(tab.frontmatter, ''))
              await (await import('@tauri-apps/api/core')).invoke('write_file', { path: s2.activeTab, content })
            }
            await (await import('@tauri-apps/api/core')).invoke('git_stage'); setStaged(true); useEditorStore.getState().setTabDirty(s2.activeTab!, false); setHasDiskChanges(false)
          } catch(e) { console.error('Save:', e); toast.error('Failed to save') }
        }}
        disabled={!(hasDiskChanges || hasUnsaved) || file?.deleted}
        className="rounded cursor-pointer text-xs text-zinc-400 hover:text-zinc-200 hover:bg-[var(--bg-hover)] disabled:opacity-30 disabled:cursor-not-allowed" style={{ padding: '8px' }}>Save</button>
        <span className="tip">Stage changes</span>
      </span>
      <span className="tip-wrap tip-bar">
        <button onClick={publish} disabled={!staged || pubState === 'committing' || pubState === 'pushing'}
        className={'rounded cursor-pointer text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed ' + ({ idle: 'bg-blue-600 text-white hover:bg-blue-500', committing: 'bg-yellow-600 text-white', pushing: 'bg-yellow-600 text-white', done: 'bg-green-600 text-white', error: 'bg-red-600 text-white' }[pubState] || 'bg-blue-600 text-white')} style={{ padding: '8px' }}>
        {pubState === 'idle' && <>Publish</>}{pubState === 'committing' && <>Commit...</>}{pubState === 'pushing' && <>Push...</>}{pubState === 'done' && <>{pubMsg} ✓</>}{pubState === 'error' && <>Failed</>}
        </button>
        <span className="tip">Git commit + push</span>
      </span>
    </div>
  )
}

// ── Main layout ──
const MARKDOWN_EXTENSIONS = ['.md', '.mdx', '.markdown']

export default function Editor() {
  const { editMode } = useEditorStore()
  const file = useEditorStore(s => s.tabs.find(t => t.path === s.activeTab))

  const openXlAiMenu = () => {
    const editor = useEditorStore.getState().blockEditor
    if (!editor) return
    const pos = editor.getTextCursorPosition()
    if (pos?.block?.id) {
      editor.extensions.get('ai')?.openAIMenuAtBlock(pos.block.id)
    }
  }

  // Ctrl/Cmd+E toggles edit mode, Ctrl/Cmd+Alt+L opens XL AI
  useKeyboard((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'e') {
      e.preventDefault(); useEditorStore.getState().setEditMode(useEditorStore.getState().editMode === 'wysiwyg' ? 'markdown' : 'wysiwyg')
    }
    if (e.ctrlKey && e.altKey && (e.code === 'KeyL' || e.key === 'l' || e.key === 'L')) {
      e.preventDefault(); openXlAiMenu()
    }
  })

  if (!file) {
    return (
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <TabBar onAiToggle={() => {}} />
        <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm italic">Open a file to start editing</div>
      </div>
    )
  }

  const isMarkdown = MARKDOWN_EXTENSIONS.some(ext => file.path.endsWith(ext))
  const isBinary = BINARY_EXTENSIONS.some(ext => file.path.endsWith(ext))

  // Shared scroll container — semua mode pake container yang sama
  let inner: React.ReactNode
  if (isBinary) {
    inner = <PreviewFallback fileName={file.name} />
  } else if (file.content == null) {
    inner = <div className="h-full flex items-center justify-center text-zinc-500 text-sm italic">Loading...</div>
  } else if (!isMarkdown) {
    inner = <PlainTextViewer content={file.content} fileName={file.name} />
  } else if (editMode === 'markdown') {
    inner = <MarkdownEditor content={file.frontmatter + (file.editedContent ?? file.content.replace(file.frontmatter, ''))} onChange={v => {
      const fmMatch = v.match(/^---[\s\S]*?\n---(?:\n|$)/)
      const newFrontmatter = fmMatch ? fmMatch[0] : ''
      const body = fmMatch ? v.slice(fmMatch[0].length) : v
      useEditorStore.getState().setFrontmatter(file.path, newFrontmatter)
      useEditorStore.getState().setEditedContent(file.path, body)
      useEditorStore.getState().setTabDirty(file.path, true)
    }} />
  } else {
    inner = <WysiwygEditor key={file.path} filePath={file.path} markdown={(file.editedContent ?? file.content).replace(file.frontmatter, '')} onSync={md => useEditorStore.getState().setEditedContent(file.path, md)} />
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      <TabBar onAiToggle={openXlAiMenu} />
      <div className="flex-1 flex flex-col min-h-0 relative">
        <div className="flex-1 min-h-0" style={{ overflowY: 'auto', padding: '48px 64px 32px' }}>
          {inner}
        </div>
      </div>
    </div>
  )
}
