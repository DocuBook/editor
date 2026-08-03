import { useEffect, useState, useRef } from 'react'
import { useCreateBlockNote, SuggestionMenuController, getDefaultReactSlashMenuItems, FormattingToolbar, FormattingToolbarController, getFormattingToolbarItems, useExtensionState } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/mantine/style.css'
import '@blocknote/xl-ai/style.css'
import { createHeadingBlockSpec, BlockNoteSchema, defaultBlockSpecs } from '@blocknote/core'
import { en as baseDict } from '@blocknote/core/locales'
import { AIExtension, AIMenuController, AIToolbarButton, getAISlashMenuItems } from '@blocknote/xl-ai'
import { en as aiDict } from '@blocknote/xl-ai/locales'
import { X, Undo2, Redo2, Sparkles, EyeOff, Command, Option, ChevronUp, ArrowBigUp, Folder } from 'lucide-react'
import { useEditorStore } from '../stores/editor'
import { useVaultStore } from '../stores/vault'
import { toast } from 'sonner'
import { buildApplyDocumentInput, AI_FORMATTING_RULES, MAX_AI_ATTEMPTS, validateOperationsSemantics, buildTaskFormattingRules, normalizeMarkdown } from '../utils/aiBlocks'
import { useKeyboard } from '../hooks/useKeyboard'
import { usePolling } from '../hooks/usePolling'
import { PROVIDERS } from '../data/providers'
import { useAiSettings } from '../stores/aiSettings'

/** Read saved AI config from persisted store for Rust backend. Always passes provider so backend can resolve key from keychain. */
function getAiConfig(): { provider?: string; model?: string; baseUrl?: string; apiKey?: string } {
  try {
    const { provider, model, apiKey } = useAiSettings.getState()
    const p = provider ? PROVIDERS.find(x => x.id === provider) : undefined
    return { provider: provider || undefined, model: model || undefined, baseUrl: p?.api, apiKey: apiKey || undefined }
  } catch (e) { console.error('[ai] getAiConfig error:', e); return {} }
}

/** Build a grounding message: current document state + selection for the model. */
/** Build a grounding message: full document as markdown (model-native) + selection context. */
function buildDocumentContext(): string {
  const ed = useEditorStore.getState().blockEditor
  if (!ed) return ''
  try {
    const md = ed.blocksToMarkdownLossy(ed.document)
    const sel = ed.getSelection()
    const selCtx = sel?.blocks?.length
      ? `\n\nSelection (preserve these block types on edit):\n${sel.blocks.map((b: any) => `- ${b.id}: ${b.type}${b.level ? ' level ' + b.level : ''}`).join('\n')}`
      : ''
    const MAX = AI_FORMATTING_RULES.maxContextChars
    const trimmed = md.length > MAX ? md.substring(0, MAX) + '\n...[truncated]' : md
    return trimmed + selCtx
  } catch { return '' }
}

/** ── Non-text preview fallback ── */
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

/** Welcome screen shown when no vault is open — Zed-style launchpad (Open Folder / Create Vault / Recent). */
function WelcomeScreen() {
  const { recent, openRecent, openVault, createVault, loading } = useVaultStore()
  const [step, setStep] = useState<'idle' | 'name'>('idle')
  const [parent, setParent] = useState('')
  const [name, setName] = useState('My Vault')

  const pickParent = async () => {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const p = await open({ directory: true, multiple: false, title: 'Create Vault', defaultPath: recent[0]?.parent })
    if (!p) return
    setParent(p); setStep('name')
  }
  const create = () => { if (name.trim()) createVault(parent, name.trim()) }

  const btn = 'w-full flex items-center gap-2 rounded-md px-4 py-2.5 text-sm disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors'
  const btnPrimary = btn + ' justify-center bg-[var(--bg-hover)] text-[var(--text-primary)] border-none hover:bg-[var(--bg-tertiary)]'
  const btnSecondary = btn + ' justify-center bg-transparent text-[var(--text-secondary)] border border-[var(--border)] hover:bg-[var(--bg-hover)]'
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="w-full max-w-[384px] text-center">
        <div className="text-xl font-semibold text-[var(--text-primary)]">DocuBook</div>
        <div className="text-xs text-[var(--text-muted)] mt-1 mb-8 leading-relaxed">
          The markdown editor that thinks like a developer — Obsidian vaults, Notion blocks, Zed-speed search, and Git — all in one.
        </div>
        <div className="flex flex-col gap-2">
          <button disabled={loading} onClick={openVault} className={btnPrimary}>
            Open Folder <span className="ml-auto text-[11px] text-[var(--text-muted)] flex items-center gap-0.5"><Command size={11} />O</span>
          </button>
          <button disabled={loading} onClick={pickParent} className={btnSecondary}>
            Create New Vault
          </button>
        </div>
        {recent.length > 0 && (
          <div className="mt-6">
            <div className="text-[10px] uppercase tracking-[1px] text-[var(--text-muted)] mb-1.5">Recent Vaults</div>
            <div className="flex flex-col gap-1">
              {recent.map(r => (
                <button key={r.path} disabled={loading} onClick={() => openRecent(r.path)}
                  className={btn + ' justify-start px-3 py-2 bg-transparent text-[var(--text-secondary)] border border-[var(--border)] hover:bg-[var(--bg-hover)]'}>
                  <Folder size={14} className="text-[var(--text-muted)] shrink-0" />
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[var(--text-primary)] font-medium">{r.name}</span>
                  <span className="ml-auto text-[10px] text-[var(--text-muted)] overflow-hidden text-ellipsis whitespace-nowrap max-w-[40%]">{r.parent}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {step === 'name' && (
          <div className="mt-4">
            <input autoFocus type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Vault name"
              onKeyDown={e => { if (e.key === 'Enter') create(); if (e.key === 'Escape') { setStep('idle'); setName('My Vault') } }}
              className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] outline-none" />
            <div className="text-[10px] text-[var(--text-muted)] mt-1 whitespace-nowrap overflow-hidden text-ellipsis">Created in {parent}</div>
          </div>
        )}
      </div>
    </div>
  )
}

/** ── Inner content components (no container — shared scroll in Editor) ── */
/** WYSIWYG block editor powered by BlockNoteJS. Loads markdown, syncs changes back. */
function WysiwygEditor({ markdown, onSync, filePath }: { markdown: string; onSync: (md: string) => void; filePath: string }) {
  const [clean, setClean] = useState('')
  useEffect(() => { setClean(markdown) }, [markdown])
  const editorRef = useRef<any>(null)
  const editor = useCreateBlockNote({
    schema: getSchema(),
    dictionary: { ...baseDict, ai: aiDict },
    extensions: [AIExtension({
      transport: {
        sendMessages: async (args: any) => {
          const { messages, abortSignal, body } = args
          if (!messages.length || abortSignal?.aborted) return new ReadableStream()
          const { invoke } = await import('@tauri-apps/api/core')
          const { listen } = await import('@tauri-apps/api/event')
          const config = getAiConfig()
          /** Fallback: always resolve provider/model from store even if config incomplete (HMR-safe) */
          const st = useAiSettings.getState()
          const resolvedProvider = config.provider || st.provider
          const resolvedModel = config.model || st.model
          const providerInfo = PROVIDERS.find(p => p.id === resolvedProvider)
          const modelDef = providerInfo?.models.find(m => m.id === resolvedModel)
          const supportsTools = modelDef?.toolCall === true && resolvedProvider !== 'opencode-go'
          const toolDefs = (body as any)?.toolDefinitions as Record<string, { description: string; inputSchema: any }> | undefined
          /** Send xl-ai's OWN tool definitions (applyDocumentOperations) so operations → suggestions work */
          const tools = (supportsTools && toolDefs) ? Object.entries(toolDefs).map(([name, def]) => ({
            type: 'function' as const,
            function: { name, description: def.description, parameters: def.inputSchema },
          })) : undefined
          const sel = editorRef.current?.getSelection()
          const selText = sel?.blocks?.length ? editorRef.current.blocksToMarkdownLossy(sel.blocks) : '';
          const stream = new ReadableStream({
            async start(controller) {
              /** Ensure API key is loaded from keychain (critical on HMR) — backend also resolves it as fallback */
              let apiKey = config.apiKey
              if (!apiKey && resolvedProvider) {
                try { apiKey = await invoke<string>('get_api_key', { provider: resolvedProvider }) } catch (e) { console.error('[ai] get_api_key failed:', e) }
                if (apiKey) useAiSettings.getState().setApiKey(apiKey)
              }
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
              /** Propagate xl-ai abort → Rust cancel (stops the in-flight reqwest stream). */
              abortSignal?.addEventListener?.('abort', () => { invoke('cancel_ai').catch(() => {}) })
              try {
                /** Ground the model with actual document state so output is doc-specific, not generic */
                const docContext = buildDocumentContext()
                const userMsg = messages.find((m: any) => m.role === 'user')
                const userText = (userMsg?.parts || []).map((p: any) => p.type === 'text' ? p.text : '').join('') || ''
                const taskRules = buildTaskFormattingRules(userText)
                const systemGrounding = docContext
                  ? `You are editing the document below. Prefer updating existing blocks over adding new ones; reference block ids EXACTLY as shown.

Document state (JSON):
${docContext}

Rules (MUST follow):
- Output ONLY the new or modified content for the requested task.
- NEVER echo the document state JSON or block ids back into the output.
- NEVER repeat the user's prompt or these instructions.
- NEVER invent block ids or content that is not in the document; if the document lacks the needed information, state that instead of fabricating.
- Use only the exact block ids from the document above when referencing existing blocks.
- Output must be free of spelling and grammar errors.
- When editing or replacing selected blocks, PRESERVE each block's type and formatting (e.g., keep a heading as a heading with the same level, keep lists as lists, keep code blocks as code blocks). Change only the content unless the user explicitly asks to change the format.${taskRules}`
                  : ''
                /** Base messages once; retry loop appends error feedback. */
                let baseMsgs: any[]
                if (supportsTools && tools) {
                  const cleanMessages = messages.map((m: any) => ({ role: m.role, content: (m.parts || []).map((p: any) => p.type === 'text' ? p.text : '').join('') || m.content || '' }))
                  baseMsgs = systemGrounding ? [{ role: 'system', content: systemGrounding }, ...cleanMessages] : cleanMessages
                } else {
                  const userContent = `${userText}${selText ? `\n\nSelected text:\n"${selText}"` : ''}

Respond with the requested content using BlockNote-compatible Markdown. Use headings (##), code blocks (\`\`\`), bullet lists (-), numbered lists (1.), blockquotes (>). No commentary.`
                  baseMsgs = systemGrounding
                    ? [{ role: 'system', content: systemGrounding }, { role: 'user', content: userContent }]
                    : [{ role: 'user', content: userContent }]
                }
                /** Retry loop: semantic validation (anti-hallucination) with error feedback. */
                let errorFeedback = ''
                let attempts = 0
                let accepted = false
                let lastReason = ''
                let emitToolCalls: any[] = []
                let emitText = ''
                while (attempts <= MAX_AI_ATTEMPTS) {
                  fullText = ''
                  toolBuffer.length = 0
                  const msgs = errorFeedback ? [...baseMsgs, { role: 'user', content: errorFeedback }] : baseMsgs
                  await invoke('ask_ai', {
                    messages: JSON.stringify(msgs),
                    ...(supportsTools && tools ? { tools: JSON.stringify(tools) } : {}),
                    provider: resolvedProvider,
                    model: resolvedModel,
                    baseUrl: providerInfo?.api,
                    apiKey,
                  })
                  /** Real correctness gate: referenced ids must exist in the document (blocking). */
                  let semanticError: string | null = null
                  for (const tc of toolBuffer) {
                    semanticError = validateOperationsSemantics(editorRef.current, tc.input)
                    if (semanticError) break
                  }
                  /** Quality is intentionally NOT gated — the transport fix (byte-buffered SSE + UTF-8)
                   *  is the real guard against corruption. Content is always written; user reviews via accept/reject. */
                  const normText = normalizeMarkdown(fullText)
                  if (!semanticError) {
                    emitToolCalls = [...toolBuffer]
                    emitText = normText
                    accepted = true
                    break
                  }
                  lastReason = semanticError || 'unknown'
                  errorFeedback = `Your previous response was rejected: ${semanticError}. Use ONLY block ids that exist in the document state above. Retry.`
                  attempts++
                }
                closed = true
                if (!accepted) {
                  /** Signal the error to xl-ai so its AIMenu shows error state with retry/cancel
                   *  (built-in getDefaultAIMenuItemsForError renders retry + cancel buttons). */
                  const reason = lastReason || 'unknown'
                  console.error('[ai] AI output failed validation:', reason)
                  toast.error('AI output was rejected — retry or cancel in the AI menu')
                  controller.error(new Error(reason))
                } else if (emitToolCalls.length > 0) {
                  for (const tc of emitToolCalls) {
                    /** Emit tool-input-available so xl-ai Chat creates a tool part → suggestions */
                    controller.enqueue({ type: 'tool-input-available', toolCallId: tc.toolCallId, toolName: tc.toolName, input: tc.input })
                  }
                  /** text-end only when a tool part was emitted (stream still open). */
                  controller.enqueue({ type: 'text-end', id })
                } else if (emitText && editorRef.current) {
                  /** Text-only: build applyDocumentOperations so xl-ai renders a suggestion (Option A) */
                  const input = await buildApplyDocumentInput(editorRef.current, emitText)
                  if (input) {
                    /** Let xl-ai create the tool part → suggestion → accept/reject flow */
                    controller.enqueue({ type: 'tool-input-available', toolCallId: 'gen-' + crypto.randomUUID(), toolName: 'applyDocumentOperations', input })
                    controller.enqueue({ type: 'text-end', id })
                  } else {
                    /** Let xl-ai show error state (retry/cancel in AIMenu) instead of silently closing. */
                    console.error('[ai] could not build document operations from AI output:', emitText.substring(0, 200))
                    controller.error(new Error('AI output could not be converted to document operations'))
                  }
                } else {
                  /** Nothing to emit (e.g., empty accepted output) — close text part normally. */
                  controller.enqueue({ type: 'text-end', id })
                }
              } catch (e) {
                console.error('[ai] transport error:', e)
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
      agentCursor: { name: 'DocuBook AI', color: 'var(--accent)' },
    })],
  }, [markdown])
  useEffect(() => { editorRef.current = editor }, [editor])

  /** Follow the AI writing position. xl-ai's built-in auto-scroll self-disables once content
   *  outgrows the viewport (its scroll-event race kills `autoScroll` under streaming), so we
   *  scroll the writing block ourselves and stop only on real user input (wheel/touch/keys). */
  const aiMenu: any = useExtensionState<any>(AIExtension, { editor, selector: (s: any) => s.aiMenuState })
  const isAiWriting = !!aiMenu && aiMenu !== 'closed' && aiMenu.status === 'ai-writing'
  const followRef = useRef(true)

  /** User scrolling (wheel/touch/scroll keys) stops the follower; re-armed on next AI run. */
  useEffect(() => {
    if (!isAiWriting) { followRef.current = true; return }
    const stop = () => { followRef.current = false }
    const opts = { capture: true, passive: true }
    const keys = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])
    const onKey = (e: KeyboardEvent) => { if (keys.has(e.key)) stop() }
    document.addEventListener('wheel', stop, opts)
    document.addEventListener('touchmove', stop, opts)
    document.addEventListener('keydown', onKey, opts)
    return () => {
      document.removeEventListener('wheel', stop, opts)
      document.removeEventListener('touchmove', stop, opts)
      document.removeEventListener('keydown', onKey, opts)
    }
  }, [isAiWriting])

  /** Token-level scroll: any DOM change in the editor while AI writes re-centers the writing block. */
  useEffect(() => {
    if (!isAiWriting || !aiMenu?.blockId) return
    const root = editor.domElement
    if (!root) return
    const scroll = () => {
      if (!followRef.current) return
      const el = root.querySelector(`[data-node-type="blockContainer"][data-id="${aiMenu.blockId}"]`)
      el?.scrollIntoView({ block: 'center' })
    }
    const mo = new MutationObserver(scroll)
    mo.observe(root, { childList: true, subtree: true, characterData: true })
    return () => mo.disconnect()
  }, [isAiWriting, aiMenu?.blockId, editor])
  const { setBlockEditor, setFlushEditor } = useEditorStore()
  const onSyncRef = useRef(onSync)
  onSyncRef.current = onSync
  const markdownRef = useRef(markdown)
  markdownRef.current = markdown
  const dirtyRef = useRef(false)
  const initialLoadRef = useRef(true)

  /** Track editor changes — skip initial load (filePath stable, remount on file change) */
  useEffect(() => {
    /** After current synchronous ops (replaceBlocks), mark initial load as done */
    queueMicrotask(() => { initialLoadRef.current = false })
    const sub = editor.onChange(() => {
      if (initialLoadRef.current) return
      dirtyRef.current = true
      useEditorStore.getState().setTabDirty(filePath, true)
      useEditorStore.getState().setUndoRedoState()
    })
    return () => sub()
  }, [editor])

  useEffect(() => {
    setBlockEditor(editor)
    return () => setBlockEditor(null)
  }, [editor, setBlockEditor])

  /** Register flush-to-store for Save button */
  useEffect(() => {
    const sync = () => {
      /** Only flush when there are real WYSIWYG edits — blocksToMarkdownLossy is not
       *  idempotent (it rewrites list formatting), so flushing an untouched doc would
       *  disturb the original markdown on every mode switch. */
      if (!dirtyRef.current) return
      try {
        const md = editor.blocksToMarkdownLossy(editor.document)
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
    try { const blocks = editor.tryParseMarkdownToBlocks(clean); editor.transact(tr => { tr.setMeta('addToHistory', false); editor.replaceBlocks(editor.document, blocks) }); useEditorStore.getState().setUndoRedoState() }
    catch (e) { console.error('BlockNote load:', e); toast.error('Failed to load editor') }
  }, [editor, clean])

  useEffect(() => () => {
    if (!dirtyRef.current) return
    try {
      const md = editor.blocksToMarkdownLossy(editor.document)
        .trim()
        .replace(/^\n+/, '')
        .replace(/\n+$/, '')
        .replace(/^(\s*)\* /gm, '$1- ')
      if (md !== markdownRef.current) onSyncRef.current(md)
    } catch {}
  }, [])

  return <BlockNoteView editor={editor} theme="dark" slashMenu={false} formattingToolbar={false}>
    <AIMenuController />
    {/** Bubble menu (formatting toolbar) with xl-ai entry so the AI text prompt opens from a selection. */}
    <FormattingToolbarController formattingToolbar={FormattingToolbarWithAI} />
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

/** Formatting toolbar (bubble menu) with the xl-ai button — shows the AI text prompt when text is selected. */
const FormattingToolbarWithAI = () => (
  <FormattingToolbar>
    {getFormattingToolbarItems()}
    <AIToolbarButton />
  </FormattingToolbar>
)

/** Plain text viewer for non-markdown files. */
function PlainTextViewer({ content, fileName }: { content: string; fileName: string }) {
  return (
    <>
      <div className="text-[11px] text-zinc-600 font-mono uppercase tracking-wider mb-4">{fileName}</div>
      <pre className="text-sm text-zinc-300 font-mono leading-relaxed whitespace-pre-wrap pt-4">{content}</pre>
    </>
  )
}

/** Raw markdown textarea editor (source mode). */
function MarkdownEditor({ content, onChange }: { content: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  return (
    <textarea ref={ref} value={content} onChange={e => onChange(e.target.value)}
      placeholder="Start writing in Markdown…"
      className="w-full min-h-full bg-transparent text-sm text-zinc-200 font-mono leading-relaxed outline-none resize-none placeholder:text-zinc-600 pt-4"
      spellCheck={false} />
  )
}

/** ── Tab bar ── */
/** Tab bar with file name, undo/redo, stage, publish, and AI toggle. */
function TabBar({ onAiToggle }: { onAiToggle: () => void }) {
  const { undo, redo, canUndo, canRedo } = useEditorStore()
  const { activeTab, tabs, switchTab, closeTab, editMode } = useEditorStore()
  const [pubState, setPubState] = useState<'idle'|'committing'|'pushing'|'done'|'error'>('idle')
  const [pubMsg, setPubMsg] = useState('')
  const [staged, setStaged] = useState(false)
  const [hasDiskChanges, setHasDiskChanges] = useState(false)
  const file = useEditorStore(s => s.tabs.find(t => t.path === s.activeTab))
  const hasUnsaved = file?.dirty ?? false
  /** Only .md files can toggle WYSIWYG ↔ markdown; .mdx is source-only, others are preview. */
  const toggleable = file ? fileKind(file.path) === 'wysiwyg' : false
  /** AI (XL) only works while the WYSIWYG editor is mounted. */
  const aiActive = file ? fileKind(file.path) === 'wysiwyg' && editMode === 'wysiwyg' : false

  /** Subscribe to activeTab separately for tab-switch effect */
  const curTab = useEditorStore(s => s.activeTab)

  useEffect(() => {
    /** Reset disk-dirty on tab switch; next git poll corrects it */
    setHasDiskChanges(false)
  }, [curTab])

  /** Git status polling (every 3s) */
  usePolling(() => {
    import('@tauri-apps/api/core').then(m =>
      m.invoke<string>('git_status').then(s => {
        try { const d = JSON.parse(s); const lines = d.status?.trim() ? d.status.split('\n').filter((l:string) => l.trim()) : [];
          const curFile = useEditorStore.getState().activeTab
          const relevant = curFile ? lines.filter((l:string) => l.length > 3 && l.substring(3).trim() === curFile) : lines
          setHasDiskChanges(relevant.some((l:string) => l.length > 1 && l[1] !== ' '));
          if (lines.length === 0 || !lines.some((l:string) => l[0] !== ' ' && l[0] !== '?')) setStaged(false) } catch {}
      }).catch(e => { console.error('Git status:', e) })
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
    <div className="ui-shell h-12 bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)] flex items-center gap-3 shrink-0 text-xs px-12">
      <span className="tip-wrap tip-bar">
        <button onClick={() => undo()} disabled={!canUndo} className="rounded cursor-pointer text-zinc-500 hover:text-zinc-300 hover:bg-[var(--bg-hover)] disabled:opacity-30 disabled:cursor-not-allowed p-2"><Undo2 size={16} /></button>
        <span className="tip">Undo <kbd><Command size={11} />Z</kbd></span>
      </span>
      <span className="tip-wrap tip-bar">
        <button onClick={() => redo()} disabled={!canRedo} className="rounded cursor-pointer text-zinc-500 hover:text-zinc-300 hover:bg-[var(--bg-hover)] disabled:opacity-30 disabled:cursor-not-allowed p-2"><Redo2 size={16} /></button>
        <span className="tip">Redo <kbd><Command size={11} /><ArrowBigUp size={11} />Z</kbd></span>
      </span>
      <div className="flex items-stretch h-full overflow-x-auto overflow-y-hidden scrollbar-none">
        {tabs.length === 0 ? <span className="text-zinc-500 italic self-center">No file open</span> : tabs.map(tab => (
          <div key={tab.path} onClick={() => switchTab(tab.path)}
            className={'tab-item flex items-center justify-center relative px-8 cursor-pointer border-r border-[var(--border-subtle)] whitespace-nowrap shrink-0 ' + (activeTab === tab.path ? 'tab-active bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-[inset_0_-1px_0_var(--tab-active-border)]' : 'tab-inactive text-[var(--text-subtle)]')}>
            <span className={tab.deleted ? 'line-through opacity-50' : undefined}>{tab.name}</span>
            {activeTab === tab.path && (
              <button onClick={e => { e.stopPropagation(); closeTab(tab.path) }} className="tab-close-btn absolute right-2 border-none bg-transparent cursor-pointer p-1 rounded text-[var(--text-subtle)] transition-opacity"><X size={14} /></button>
            )}
          </div>
        ))}
      </div>
      <div className="flex-1" />
      <span className="tip-wrap tip-bar">
        <button onClick={onAiToggle} disabled={!aiActive}
        className="rounded text-xs flex items-center gap-1 disabled:opacity-30 disabled:cursor-not-allowed enabled:cursor-pointer enabled:text-zinc-400 enabled:hover:text-zinc-200 enabled:hover:bg-[var(--bg-hover)] p-2"><Sparkles size={14} /></button>
        <span className="tip">{!file ? 'Open a file first' : !toggleable ? 'AI works on .md files' : editMode === 'markdown' ? 'AI works in Editor mode' : 'Ask AI / Write with AI'} <kbd><ChevronUp size={10} /><Option size={10} />L</kbd></span>
      </span>
      <span className="tip-wrap tip-bar">
        <button onClick={() => useEditorStore.getState().toggleEditMode()} disabled={!toggleable}
        className={'rounded text-xs p-2 disabled:opacity-30 disabled:cursor-not-allowed enabled:cursor-pointer ' + (editMode === 'markdown' ? 'bg-zinc-700 text-white' : 'enabled:text-zinc-500 enabled:hover:text-zinc-300 enabled:hover:bg-[var(--bg-hover)]')}
        >{editMode === 'wysiwyg' ? 'Code' : 'Editor'}</button>
        <span className="tip">{tabs.length === 0 ? 'Open a file first' : toggleable ? 'Switch mode to ' + (editMode === 'wysiwyg' ? 'source' : 'editor') : (file && fileKind(file.path) === 'markdown' ? 'Source mode only (.mdx)' : 'Preview only')} <kbd><Command size={11} /><ArrowBigUp size={11} />E</kbd></span>
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
              await (await import('@tauri-apps/api/core')).invoke('write_file', { path: s2.activeTab, content })
            }
            await (await import('@tauri-apps/api/core')).invoke('git_stage'); setStaged(true); useEditorStore.getState().setTabDirty(s2.activeTab!, false); setHasDiskChanges(false)
          } catch(e) { console.error('Save:', e); toast.error('Failed to save') }
        }}
        disabled={!(hasDiskChanges || hasUnsaved) || file?.deleted}
        className="rounded cursor-pointer text-xs text-zinc-400 hover:text-zinc-200 hover:bg-[var(--bg-hover)] disabled:opacity-30 disabled:cursor-not-allowed p-2">Save</button>
        <span className="tip">Stage changes</span>
      </span>
      <span className="tip-wrap tip-bar">
        <button onClick={publish} disabled={!staged || pubState === 'committing' || pubState === 'pushing'}
        className={'rounded cursor-pointer text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed p-2 ' + ({ idle: 'bg-blue-600 text-white hover:bg-blue-500', committing: 'bg-yellow-600 text-white', pushing: 'bg-yellow-600 text-white', done: 'bg-green-600 text-white', error: 'bg-red-600 text-white' }[pubState] || 'bg-blue-600 text-white')}>
        {pubState === 'idle' && <>Publish</>}{pubState === 'committing' && <>Commit...</>}{pubState === 'pushing' && <>Push...</>}{pubState === 'done' && <>{pubMsg} ✓</>}{pubState === 'error' && <>Failed</>}
        </button>
        <span className="tip">Git commit + push</span>
      </span>
    </div>
  )
}

/** ── Main layout ── */
/** Extensions that support both WYSIWYG + markdown source (toggleable). */
const MD_EXTENSIONS = ['.md', '.markdown']
/** Extensions that are markdown-source only (MDX components unsupported in WYSIWYG). */
const MDX_EXTENSIONS = ['.mdx']
/** Classify a file: 'wysiwyg' (md — toggleable), 'markdown' (mdx — forced source), 'preview' (others). */
const fileKind = (path: string): 'wysiwyg' | 'markdown' | 'preview' => {
  if (MD_EXTENSIONS.some(ext => path.endsWith(ext))) return 'wysiwyg'
  if (MDX_EXTENSIONS.some(ext => path.endsWith(ext))) return 'markdown'
  return 'preview'
}

export default function Editor() {
  const { editMode } = useEditorStore()
  const file = useEditorStore(s => s.tabs.find(t => t.path === s.activeTab))
  const vaultOpen = useVaultStore(s => s.isOpen)

  const openXlAiMenu = () => {
    const editor = useEditorStore.getState().blockEditor
    if (!editor) return
    const pos = editor.getTextCursorPosition()
    if (pos?.block?.id) {
      editor.extensions.get('ai')?.openAIMenuAtBlock(pos.block.id)
    }
  }

  /** Ctrl/Cmd+Shift+E toggles edit mode (not ⌘E — conflicts with BlockNote's inline-code mark), Ctrl/Cmd+Alt+L opens XL AI */
  useKeyboard((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'E' || e.key === 'e')) {
      e.preventDefault()
      const s = useEditorStore.getState()
      const active = s.tabs.find(t => t.path === s.activeTab)
      /** Only .md files toggle; .mdx is source-only, others are preview. */
      if (active && fileKind(active.path) === 'wysiwyg') s.toggleEditMode()
    }
    if (e.ctrlKey && e.altKey && (e.code === 'KeyL' || e.key === 'l' || e.key === 'L')) {
      e.preventDefault(); openXlAiMenu()
    }
  })

  if (!file) {
    return (
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <TabBar onAiToggle={() => {}} />
        {vaultOpen
          ? <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm italic">Select a file from the sidebar</div>
          : <WelcomeScreen />}
      </div>
    )
  }

  const kind = fileKind(file.path)
  const isBinary = BINARY_EXTENSIONS.some(ext => file.path.endsWith(ext))

  /** Shared scroll container — all modes use the same container. */
  let inner: React.ReactNode
  if (isBinary) {
    inner = <PreviewFallback fileName={file.name} />
  } else if (file.content == null) {
    inner = <div className="h-full flex items-center justify-center text-zinc-500 text-sm italic">Loading...</div>
  } else if (kind === 'preview') {
    inner = <PlainTextViewer content={file.content} fileName={file.name} />
  } else if (kind === 'markdown' || editMode === 'markdown') {
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
        <div className="flex-1 min-h-0 overflow-y-auto pt-12 px-16 pb-8">
          {inner}
        </div>
      </div>
    </div>
  )
}
