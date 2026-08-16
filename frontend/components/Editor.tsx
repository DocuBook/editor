import { useEffect, useState, useRef } from 'react'
import { useCreateBlockNote, SuggestionMenuController, getDefaultReactSlashMenuItems, FormattingToolbar, FormattingToolbarController, getFormattingToolbarItems, useExtensionState, useBlockNoteEditor, useComponentsContext, useExtension, useEditorState, DeleteLinkButton, LinkToolbarController, type LinkToolbarProps } from '@blocknote/react'
import { LinkToolbarExtension, FormattingToolbarExtension, ShowSelectionExtension } from '@blocknote/core/extensions'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/mantine/style.css'
import '@blocknote/xl-ai/style.css'
import { createHeadingBlockSpec, BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs, createExtension, combineByGroup, SourceBlockWithPreviewExtension, insertOrUpdateBlockForSlashMenu } from '@blocknote/core'
import { createReactMathBlockSpec, createReactInlineMathSpec, getMathSlashMenuItems, locales as mathLocales } from '@blocknote/math-block'
import { createReactDiagramBlockSpec, getDiagramSlashMenuItems, locales as diagramLocales } from '@blocknote/diagram-block'
import { Plugin } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { en as baseDict } from '@blocknote/core/locales'
import { AIExtension, AIMenuController, AIToolbarButton, getAISlashMenuItems } from '@blocknote/xl-ai'
import { en as aiDict } from '@blocknote/xl-ai/locales'
import { X, Undo2, Redo2, Sparkles, EyeOff, Command, Option, ChevronUp, ArrowBigUp, Folder, GitBranch, Link2, Type, ExternalLink } from 'lucide-react'
import { useEditorStore } from '../stores/editor'
import { useVaultStore } from '../stores/vault'
import OnboardingGuide, { isOnboardingDone } from './OnboardingGuide'
import { invoke, listen, openDir } from '../lib/ipc'
import { toast } from 'sonner'
import { buildApplyDocumentInput, AI_FORMATTING_RULES, MAX_AI_ATTEMPTS, validateOperationsSemantics, buildTaskFormattingRules, normalizeMarkdown, isVaultGenerationIntent, buildVaultGroundingPrompt, buildEditSystemPrompt, AI_MARKDOWN_INSTRUCTION } from '../utils/aiBlocks'
import { uuid } from '../utils/uuid'
import { mathDollarToMathML } from '../utils/mathMarkdown'
// Mermaid is a singleton — wrapping render here also patches the instance
// @blocknote/diagram-block uses. Serialize renders (mermaid keeps global
// state; parallel renders race on slow engines like WKWebView) and surface
// the real error instead of blocknote's generic "Invalid diagram".
import mermaid from 'mermaid'
const _mermaidRender = mermaid.render.bind(mermaid)
let _mermaidQueue: Promise<unknown> = Promise.resolve()
;(mermaid as any).render = (id: string, text: string) => {
  const run = _mermaidQueue.then(() =>
    _mermaidRender(id, text).catch((e: unknown) => {
      console.error('[mermaid render]', id, e)
      throw e
    }),
  )
  _mermaidQueue = run.catch(() => {})
  return run
}
import { useKeyboard } from '../hooks/useKeyboard'
import { useGitStatus } from '../stores/gitStatus'
import { useAiSettings, CUSTOM_PROVIDER_ID } from '../stores/aiSettings'
import { useTheme } from '../stores/theme'

/** Batch AI token deltas into one text-delta part per tick — fewer ProseMirror
 *  document writes while the AI types (smooth instead of janky streaming). */
const AI_DELTA_BATCH_MS = 50

/** Lazy-load the provider catalog (2.17 MB — keep it out of the initial bundle). */
let _providersCache: typeof import('../data/providers').PROVIDERS | null = null
async function getProviders() {
  if (!_providersCache) _providersCache = (await import('../data/providers')).PROVIDERS
  return _providersCache
}

/** Read saved AI config from persisted store for Rust backend. The API key is
 *  intentionally NOT sent — the backend resolves it from the keychain (SEC-5). */
async function getAiConfig(): Promise<{ provider?: string; model?: string; baseUrl?: string }> {
  try {
    const st = useAiSettings.getState()
    const p = st.provider ? (await getProviders()).find(x => x.id === st.provider) : undefined
    /** Custom OpenAI-compatible endpoints aren't in the catalog — their base URL
     *  lives in the store and is bound server-side at save time. */
    const baseUrl = p?.api || (st.provider === CUSTOM_PROVIDER_ID ? st.baseUrls[st.provider] : undefined)
    return { provider: st.provider || undefined, model: st.model || undefined, baseUrl }
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
      <span className="text-sm"><span className="text-foreground-subtle">{fileName}</span> — preview only</span>
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
      mathBlock: createReactMathBlockSpec(),
      diagram: createReactDiagramBlockSpec(),
    },
    inlineContentSpecs: {
      ...defaultInlineContentSpecs,
      math: createReactInlineMathSpec(),
    },
  })
  return _schema
}

/** Visual indicator for `[[wikilink]]` text: accent + underline + pointer so
 *  Cmd+Click navigation is discoverable. ProseMirror decorations only — the
 *  stored content stays literal `[[Title]]` (markdown round-trip untouched). */
const wikilinkStyler = createExtension({
  key: 'wikilinkStyler',
  prosemirrorPlugins: [
    new Plugin({
      props: {
        decorations(state) {
          const decos: Decoration[] = []
          const re = /\[\[([^\]]+)\]\]/g
          state.doc.descendants((node, pos) => {
            if (node.isText) {
              const text = node.text || ''
              let m: RegExpExecArray | null
              while ((m = re.exec(text)) !== null) {
                decos.push(Decoration.inline(pos + m.index, pos + m.index + m[0].length, {
                  'data-wikilink': '1',
                  style: 'color: var(--color-accent); text-decoration: underline; cursor: pointer;',
                }))
              }
            }
            return true
          })
          return DecorationSet.create(state.doc, decos)
        },
        /** Cmd/Ctrl+Click on a `[[wikilink]]` opens the note. Must run here
         *  (ProseMirror prop) and return true: PM core's `selectNodeModifier`
         *  (metaKey on mac) would otherwise select the whole paragraph block
         *  on mouseup — conflicting with navigation and crashing the editor
         *  when the document is swapped mid node-selection. */
        handleClick(view, pos, event) {
          if (!(event.metaKey || event.ctrlKey)) return false
          const t = event.target as HTMLElement | null
          if (!(t?.tagName === 'SPAN' && t.getAttribute('data-wikilink') === '1')) return false
          const $pos = view.state.doc.resolve(pos)
          const text = $pos.parent.textContent || ''
          const local = pos - $pos.start()
          const re = /\[\[([^\]]+)\]\]/g
          let m: RegExpExecArray | null
          while ((m = re.exec(text)) !== null) {
            if (local >= m.index && local <= m.index + m[0].length) {
              invoke<string>('wiki_resolve', { title: m[1] })
                .then(path => { if (path) useEditorStore.getState().openFile(path, path.split('/').pop() || path) })
                .catch(() => {})
              return true // consumed — PM skips its own selection entirely
            }
          }
          return false
        },
      },
    }),
  ],
})

/** Welcome screen shown when no vault is open — launchpad (Open Folder / Create Vault / Recent). */
function WelcomeScreen() {
  const { recent, openRecent, openVault, createVault, cloneVault, loading } = useVaultStore()
  const [step, setStep] = useState<'idle' | 'name' | 'clone'>('idle')
  const [parent, setParent] = useState('')
  const [name, setName] = useState('My Vault')
  const [repoUrl, setRepoUrl] = useState('')
  const [cloneErr, setCloneErr] = useState('')

  const pickParent = async (title: string) => {
    const p = await openDir({ title, defaultPath: recent[0]?.parent })
    if (!p) return
    setParent(p)
  }
  const create = () => { if (name.trim()) createVault(parent, name.trim()) }
  const pickCreateParent = async () => { await pickParent('Create Vault'); setStep('name') }
  const pickCloneParent = async () => { await pickParent('Clone Repository'); setCloneErr(''); setRepoUrl(''); setStep('clone') }
  const clone = async () => {
    if (!repoUrl.trim() || !parent) return
    setCloneErr('')
    try { await cloneVault(repoUrl.trim(), parent) }
    catch (e) { setCloneErr(String(e)) }
  }

  const btn = 'w-full flex items-center gap-2 rounded-md px-4 py-2.5 text-sm disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors'
  const btnPrimary = btn + ' justify-center bg-surface-active text-foreground border-none hover:bg-surface-hover'
  const btnSecondary = btn + ' justify-center bg-transparent text-foreground-secondary border border-border hover:bg-surface-active'
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="w-full max-w-[384px] text-center">
        <div className="text-xl font-semibold text-foreground">DocuBook Editor</div>
        <div className="text-xs text-muted mt-1 mb-8 leading-relaxed">
          The markdown editor that thinks like a developer — Obsidian vaults, Notion blocks, Zed-speed search, and Git — all in one.
        </div>
        <div className="flex flex-col gap-2">
          <button disabled={loading} onClick={openVault} className={btnPrimary}>
            Open Folder <span className="ml-auto text-[11px] text-muted flex items-center gap-0.5"><Command size={11} />O</span>
          </button>
          <button disabled={loading} onClick={pickCreateParent} className={btnSecondary}>
            Create New Vault
          </button>
          <button disabled={loading} onClick={pickCloneParent} className={btnSecondary}>
            Clone Repository <GitBranch size={13} className="text-muted" />
          </button>
        </div>
        {recent.length > 0 && (
          <div className="mt-6">
            <div className="text-[10px] uppercase tracking-[1px] text-muted mb-1.5">Recent Vaults</div>
            <div className="flex flex-col gap-1">
              {recent.map(r => (
                <button key={r.path} disabled={loading} onClick={() => openRecent(r.path)}
                  className={btn + ' justify-start px-3 py-2 bg-transparent text-foreground-secondary border border-border hover:bg-surface-active'}>
                  <Folder size={14} className="text-muted shrink-0" />
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap text-foreground font-medium">{r.name}</span>
                  <span className="ml-auto text-[10px] text-muted overflow-hidden text-ellipsis whitespace-nowrap max-w-[40%]">{r.parent}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {step === 'name' && (
          <div className="mt-4 text-left">
            <input autoFocus type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Vault name"
              onKeyDown={e => { if (e.key === 'Enter') create(); if (e.key === 'Escape') { setStep('idle'); setName('My Vault') } }}
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground outline-none" />
            <div className="text-[10px] text-muted mt-1 truncate">Created in {parent}</div>
          </div>
        )}
        {step === 'clone' && (
          <div className="mt-4 text-left">
            <input autoFocus type="text" value={repoUrl} onChange={e => { setRepoUrl(e.target.value); setCloneErr('') }} placeholder="https://github.com/user/repo.git"
              onKeyDown={e => { if (e.key === 'Enter') clone(); if (e.key === 'Escape') { setStep('idle'); setCloneErr('') } }}
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground outline-none" />
            <div className="flex items-center gap-2 mt-2">
              <button disabled={loading || !repoUrl.trim()} onClick={clone} className={btnPrimary + ' !w-auto px-4'}>
                {loading ? 'Cloning…' : 'Clone'}
              </button>
              <button onClick={() => { setStep('idle'); setCloneErr('') }} className="text-xs text-muted hover:text-foreground-secondary cursor-pointer bg-transparent border-none">Cancel</button>
            </div>
            {cloneErr && <div className="mt-2 text-[11px] text-danger leading-relaxed">Clone failed: {cloneErr}</div>}
            <div className="text-[10px] text-muted mt-2 leading-relaxed">
              Clone into {parent}. Private repos need your SSH key or git credential helper (macOS Keychain) already configured on this machine — the app uses them automatically. Public repos need no setup.
            </div>
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
    dictionary: { ...baseDict, ai: aiDict, math: mathLocales.en, diagram: diagramLocales.en },
    extensions: [AIExtension({
      transport: {
        sendMessages: async (args: any) => {
          const { messages, abortSignal, body } = args
          if (!messages.length || abortSignal?.aborted) return new ReadableStream()
          const config = await getAiConfig()
          /** Fallback: always resolve provider/model from store even if config incomplete (HMR-safe) */
          const st = useAiSettings.getState()
          const resolvedProvider = config.provider || st.provider
          const resolvedModel = config.model || st.model
          const providerInfo = (await getProviders()).find(p => p.id === resolvedProvider)
          const modelDef = providerInfo?.models.find(m => m.id === resolvedModel)
          /** Tool-call support = model capability (catalog) AND measured gateway
           *  compatibility (test_connection probe, stored per provider+model). No
           *  static exclusions: a provider/model measured tools:false stays
           *  text-only, custom endpoints unlock when the probe measures tools:true. */
          const probe = st.probeTools[resolvedProvider]?.[resolvedModel]
          const supportsTools = resolvedProvider === CUSTOM_PROVIDER_ID
            ? probe === true
            : modelDef?.toolCall === true && probe !== false
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
              const id = uuid()
              let fullText = ''
              controller.enqueue({ type: 'text-start', id })
              let closed = false
              /** Batch token deltas and flush on a short timer: one ProseMirror doc
               *  write per batch instead of per token is the difference between
               *  janky and smooth AI typing. fullText still accumulates per event. */
              let pendingDelta = ''
              let flushTimer: ReturnType<typeof setTimeout> | undefined
              const flushDeltas = () => {
                flushTimer = undefined
                if (closed || !pendingDelta) return
                controller.enqueue({ type: 'text-delta', delta: pendingDelta, id })
                pendingDelta = ''
              }
              const unsubToken = await listen<string>('ai:token', e => {
                if (abortSignal?.aborted || closed) { try { controller.close() } catch {}; return }
                fullText += e.payload
                pendingDelta += e.payload
                if (!bufferText && !flushTimer) flushTimer = setTimeout(flushDeltas, AI_DELTA_BATCH_MS)
              })
              const toolBuffer: any[] = []
              /** Point 5: Path A (tools sent) can mix text+tool calls in one response.
               *  Buffer text deltas and decide at the end — meaningful ops win
               *  (ops-only output, buffered commentary dropped), otherwise the
               *  buffered text is flushed. Path B (no tools) keeps live typing. */
              let bufferText = true
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
                /** Resolve wikilinks + search vault for additional grounding context.
                 *  Token-budgeted server-side (2k chars per file, 3 search results max). */
                let vaultContext = ''
                try {
                  const activePath = useEditorStore.getState().activeTab || ''
                  vaultContext = await invoke<string>('ai_grounding_context', { query: userText, activePath })
                } catch { /* no vault or no wiki index — skip grounding */ }
                const hasVaultContext = vaultContext.trim().length > 0
                /** Vault-first generation: the edit rules below de-authorize vault
                 *  content ("NEVER invent … content that is not in the document"),
                 *  so a request referencing [[wikilinks]] / asking / generating /
                 *  targeting an empty doc gets forced into an applyDocumentOperations
                 *  edit with nothing to anchor on. Detect that intent → skip the
                 *  tool path and use the vault context as the model's only source;
                 *  output lands as plain-Markdown insert (accept/revert). */
                const isVaultGeneration = isVaultGenerationIntent(userText, hasVaultContext, docContext)
                const useTools = supportsTools && !!tools && !isVaultGeneration
                bufferText = useTools
                const systemGrounding = isVaultGeneration
                  ? buildVaultGroundingPrompt(vaultContext)
                  : docContext
                  ? buildEditSystemPrompt(docContext, vaultContext, taskRules)
                  : ''
                /** Base messages once; retry loop appends error feedback. */
                let baseMsgs: any[]
                if (useTools) {
                  const cleanMessages = messages.map((m: any) => ({ role: m.role, content: (m.parts || []).map((p: any) => p.type === 'text' ? p.text : '').join('') || m.content || '' }))
                  baseMsgs = systemGrounding ? [{ role: 'system', content: systemGrounding }, ...cleanMessages] : cleanMessages
                } else {
                  const userContent = `${userText}${selText ? `\n\nSelected text:\n"${selText}"` : ''}\n\n${AI_MARKDOWN_INSTRUCTION}`
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
                  pendingDelta = ''
                  toolBuffer.length = 0
                  const msgs = errorFeedback ? [...baseMsgs, { role: 'user', content: errorFeedback }] : baseMsgs
                  await invoke('ask_ai', {
                    messages: JSON.stringify(msgs),
                    ...(useTools ? { tools: JSON.stringify(tools) } : {}),
                    provider: resolvedProvider,
                    model: resolvedModel,
                    baseUrl: providerInfo?.api || config.baseUrl,
                  })
                  /** Diagnostic: this line must appear AFTER a completed ask_ai.
                   *  If xl-ai errors but this never logs, the stream never
                   *  resolved (stuck SSE) — not a transport branch failure. */
                  console.info('[ai] ask_ai resolved', { chars: fullText.length, tools: toolBuffer.length })
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
                  lastReason = semanticError ?? 'unknown'
                  errorFeedback = `Your previous response was rejected: ${semanticError}. Use ONLY block ids that exist in the document state above. Retry.`
                  attempts++
                }
                closed = true
                /** Point 5: when the model produced meaningful tool ops they are the
                 *  ONLY output channel — drop the buffered commentary text so the
                 *  suggestion never overwrites/duplicates streamed prose. Otherwise
                 *  flush (Path B already streamed live; Path A flushes now). */
                const meaningfulOps = accepted
                  ? emitToolCalls.filter((tc: any) => tc?.input && Array.isArray(tc.input.operations) && tc.input.operations.length > 0)
                  : []
                if (meaningfulOps.length > 0) {
                  pendingDelta = ''
                } else {
                  flushDeltas()
                }
                if (!accepted) {
                  /** Signal the error to xl-ai so its AIMenu shows error state with retry/cancel
                   *  (built-in getDefaultAIMenuItemsForError renders retry + cancel buttons). */
                  const reason = lastReason || 'unknown'
                  console.error('[ai] AI output failed validation:', { provider: resolvedProvider, model: resolvedModel, supportsTools, attempts, reason, toolCalls: toolBuffer.length, textLen: fullText.length, textSnippet: fullText.substring(0, 300) })
                  toast.error('AI output was rejected: ' + reason)
                  controller.error(new Error(reason))
                } else if (emitToolCalls.length > 0) {
                  /** A model forced by tool_choice:"required" often calls with EMPTY
                   *  operations when it decides nothing needs changing. xl-ai hard-fails
                   *  on empty input ("No operations seen"), so filter those out and
                   *  close gracefully instead of surfacing an error. */
                  if (meaningfulOps.length === 0) {
                    console.info('[ai] tool calls had no operations — treating as no change', { provider: resolvedProvider, model: resolvedModel, toolCalls: emitToolCalls.length })
                    /** Close the AI menu instead of finishing OK — xl-ai enters
                     *  user-reviewing (empty accept/revert) on ANY successful call,
                     *  so a no-change result must not "succeed" normally. Access
                     *  the extension via editor.extensions (same as openXlAiMenu). */
                    const aiExt = editorRef.current && (editorRef.current as any).extensions && (editorRef.current as any).extensions.get('ai')
                    if (aiExt && typeof aiExt.closeAIMenu === 'function') aiExt.closeAIMenu()
                    toast.info('AI made no document changes')
                    controller.enqueue({ type: 'text-end', id })
                  } else {
                    for (const tc of meaningfulOps) {
                      /** Emit tool-input-available so xl-ai Chat creates a tool part → suggestions */
                      controller.enqueue({ type: 'tool-input-available', toolCallId: tc.toolCallId, toolName: tc.toolName, input: tc.input })
                    }
                    /** text-end only when a tool part was emitted (stream still open). */
                    controller.enqueue({ type: 'text-end', id })
                  }
                } else if (emitText && editorRef.current) {
                  /** Text-only: build applyDocumentOperations so xl-ai renders a suggestion (Option A) */
                  let input = await buildApplyDocumentInput(editorRef.current, emitText)
                  /** Path A (tools sent) produced text but not parseable markdown —
                   *  e.g. empty document where model explains why it can't edit.
                   *  Retry once with Path B prompt (no tools, explicit markdown
                   *  instruction) before surfacing an error. */
                  if (input) {
                    /** Let xl-ai create the tool part → suggestion → accept/reject flow */
                    controller.enqueue({ type: 'tool-input-available', toolCallId: 'gen-' + uuid(), toolName: 'applyDocumentOperations', input })
                    controller.enqueue({ type: 'text-end', id })
                  } else {
                    /** Text that can't be parsed into blocks: the streamed text is
                     *  already written into the document (flushed above) — close
                     *  cleanly so xl-ai enters user-reviewing (accept/revert) on it.
                     *  No Path A→B retry: a text-only model always answers in text,
                     *  so regenerating doubles latency and fails identically. */
                    console.info('[ai] text kept as streamed result (not converted to blocks)', { provider: resolvedProvider, model: resolvedModel, textLen: emitText.length, textSnippet: emitText.substring(0, 200) })
                    controller.enqueue({ type: 'text-end', id })
                  }
                } else {
                  /** Nothing to emit — empty output AND no tool calls = gateway
                   *  anomaly (unlike a deliberate empty tool call, which is a
                   *  no-change). Surface it as an error with the details logged. */
                  console.error('[ai] empty AI result:', { provider: resolvedProvider, model: resolvedModel, supportsTools, attempts, lastReason, toolCalls: toolBuffer.length, textLen: fullText.length })
                  controller.error(new Error('AI returned an empty response'))
                }
              } catch (e) {
                console.error('[ai] transport error:', e)
                try { controller.error(e) } catch {}
              } finally {
                closed = true; if (flushTimer) clearTimeout(flushTimer); unsubToken(); unsubTool(); unsubToolsDone(); try { controller.close() } catch {} 
              }
            }
          })
          return stream
        },
        reconnectToStream: async () => null,
      },
      agentCursor: { name: 'DocuBook AI', color: 'var(--color-ai-cursor)' },
    }), wikilinkStyler],
  }, [markdown])
  useEffect(() => { editorRef.current = editor }, [editor])

  /** Hover hint for [[wikilink]]: native title tooltips get cancelled by
   *  ProseMirror's decoration re-rendering, so render a small floating hint
   *  via event delegation (immune to span re-creation). */
  useEffect(() => {
    const el = editor.domElement
    if (!el) return
    const tip = document.createElement('div')
    tip.setAttribute('data-wikilink-tip', '1')
    tip.textContent = 'Cmd+Click to open'
    tip.style.cssText = 'position:fixed;z-index:9999;display:none;pointer-events:none;padding:3px 8px;border-radius:6px;font-size:11px;white-space:nowrap;background:var(--color-surface,#2a2a2c);color:var(--color-foreground,#fafafa);border:1px solid var(--color-border,#3a3a3c);box-shadow:0 4px 12px rgba(0,0,0,0.3);'
    document.body.appendChild(tip)
    const show = (x: number, y: number) => { tip.style.left = `${x + 10}px`; tip.style.top = `${y + 16}px`; tip.style.display = 'block' }
    const hide = () => { tip.style.display = 'none' }
    const onMouseOver = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (t?.tagName === 'SPAN' && t.getAttribute('data-wikilink') === '1') show(e.clientX, e.clientY)
      else hide()
    }
    el.addEventListener('mouseover', onMouseOver)
    el.addEventListener('mouseleave', hide)
    return () => { el.removeEventListener('mouseover', onMouseOver); el.removeEventListener('mouseleave', hide); tip.remove() }
  }, [editor])

  /** Cmd/Ctrl+Click on a `[[wikilink]]` opens the referenced note
   *  (Obsidian-style). Plain click keeps caret positioning for editing. */
  useEffect(() => {
    const el = editor.domElement
    if (!el) return
    const onClick = (e: MouseEvent) => {
      // Resolve the click position directly (caretRangeFromPoint) — Meta+click
      // does not move the ProseMirror selection, so getSelection() is unreliable.
      const range = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null
      const node = range?.startContainer ?? null
      const off = range?.startOffset ?? 0
      if (!node || node.nodeType !== Node.TEXT_NODE) return
      const text = node.textContent || ''
      const re = /\[\[([^\]]+)\]\]/g
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        if (off >= m.index && off <= m.index + m[0].length) {
          const title = m[1]
          const open = () => {
            invoke<string>('wiki_resolve', { title })
              .then(path => { if (path) useEditorStore.getState().openFile(path, path.split('/').pop() || path) })
              .catch(() => {})
          }
          // Meta/Ctrl+Click navigation is handled by the wikilinkStyler
          // ProseMirror handleClick prop (consumes the click before PM's
          // selectNodeModifier block selection); this listener only serves
          // the plain-click hint.
          toast('Wikilink — Cmd+Click or Open to navigate', {
            action: { label: 'Open', onClick: open },
            duration: 4000,
          })
          break
        }
      }
    }
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  }, [editor])

  /** Follow the AI writing position. xl-ai's built-in auto-scroll self-disables once content
   *  outgrows the viewport (its scroll-event race kills `autoScroll` under streaming), so we
   *  scroll the writing block ourselves and stop only on real user input (wheel/touch/keys). */
  const aiMenu: any = useExtensionState<any>(AIExtension, { editor, selector: (s: any) => s.aiMenuState })
  const isAiWriting = !!aiMenu && aiMenu !== 'closed' && aiMenu.status === 'ai-writing'
  const followRef = useRef(true)
  /** Mirrors isAiWriting for the onChange gate (avoids re-subscribing). */
  const aiWritingRef = useRef(false)
  const prevAiWriting = useRef(false)
  /** Settle tab-dirty + undo state once when AI writing ends — the per-flush
   *  onChange is gated during streaming (it fired per token write). */
  useEffect(() => {
    if (prevAiWriting.current && !isAiWriting) {
      useEditorStore.getState().setTabDirty(filePath, true)
      useEditorStore.getState().setUndoRedoState()
    }
    prevAiWriting.current = isAiWriting
    aiWritingRef.current = isAiWriting
  }, [isAiWriting, filePath])

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

  /** Token-level scroll: any DOM change in the editor while AI writes keeps the
   *  writing block in view. rAF-throttled AND viewport-aware — it only scrolls
   *  when the block actually leaves the visible area (minimal delta). Constant
   *  re-centering per frame was what made AI typing look janky. */
  useEffect(() => {
    if (!isAiWriting || !aiMenu?.blockId) return
    const root = editor.domElement
    if (!root) return
    let raf = 0
    const scroll = () => {
      if (!followRef.current || raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const el = root.querySelector(`[data-node-type="blockContainer"][data-id="${aiMenu.blockId}"]`)
        if (!el) return
        const box = el.getBoundingClientRect()
        // Nearest scrollable ancestor — the editor's scroll container.
        let scroller: HTMLElement | null = el.parentElement
        while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement
        if (!scroller) { el.scrollIntoView({ block: 'nearest' }); return }
        const cbox = scroller.getBoundingClientRect()
        const margin = 32
        if (box.bottom > cbox.bottom - margin) {
          scroller.scrollTop += box.bottom - (cbox.bottom - margin)   // scroll down
        } else if (box.top < cbox.top + margin) {
          scroller.scrollTop -= (cbox.top + margin) - box.top         // scroll up
        }
        // block fully in view — do nothing (no jump, no repaint)
      })
    }
    const mo = new MutationObserver(scroll)
    mo.observe(root, { childList: true, subtree: true, characterData: true })
    return () => { mo.disconnect(); if (raf) cancelAnimationFrame(raf) }
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
      if (aiWritingRef.current) return // gate UI store spam during AI streaming — settled once at writing end
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
    try {
      /** Math blocks export as $/$$ but blocknote's markdown parser has no
       *  $ handling — pre-convert to <math> HTML so saved math re-renders. */
      const blocks = editor.tryParseMarkdownToBlocks(mathDollarToMathML(clean))
      editor.transact(tr => { tr.setMeta('addToHistory', false); editor.replaceBlocks(editor.document, blocks) }); useEditorStore.getState().setUndoRedoState() }
    catch (e) { console.error('BlockNote load:', e); toast.error('Failed to load editor') }
  }, [editor, clean])

  useEffect(() => () => {
    if (!dirtyRef.current) return
    /** Flush on unmount. Must NOT run synchronously: blocksToMarkdownLossy →
     *  exportBlocks → toExternalHTML uses flushSync internally, and React
     *  forbids flushSync from inside a lifecycle method (unmount cleanup runs
     *  during commit). Defer to a microtask so the unmount commit finishes
     *  first. */
    queueMicrotask(() => {
      try {
        const md = editor.blocksToMarkdownLossy(editor.document)
          .trim()
          .replace(/^\n+/, '')
          .replace(/\n+$/, '')
          .replace(/^(\s*)\* /gm, '$1- ')
        if (md !== markdownRef.current) onSyncRef.current(md)
      } catch {}
    })
  }, [])

  return <BlockNoteView editor={editor} theme={useTheme(s => s.name)} slashMenu={false} formattingToolbar={false} linkToolbar={false}>
    <AIMenuController />
    {/** Bubble menu (formatting toolbar) with xl-ai entry so the AI text prompt opens from a selection. */}
    <FormattingToolbarController formattingToolbar={FormattingToolbarWithAI} />
    <LinkToolbarController linkToolbar={WikiLinkToolbar} />
    <SuggestionMenuController triggerCharacter="/"
      getItems={async (query) => {
        const defaultItems = getDefaultReactSlashMenuItems(editor)
        const aiItems = getAISlashMenuItems(editor)
        const mathItems = getMathSlashMenuItems(editor)
        const diagramItems = getDiagramSlashMenuItems(editor).map(item => ({
          ...item,
          /** The diagram-block package inserts the block but leaves the popup
           *  closed — the user types into the document instead of the source
           *  editor and the diagram never saves. Parity with the math block:
           *  open the source popup right after insert. */
          onItemClick: () => {
            const block = insertOrUpdateBlockForSlashMenu(editor as any, {
              type: 'diagram',
              content: 'graph TD\n    A[Start] --> B[Stop]',
            } as any)
            editor.getExtension(SourceBlockWithPreviewExtension)
              ?.store.setState(state => ({ ...state, popupOpen: block.id }))
            requestAnimationFrame(() => {
              editor.setTextCursorPosition(block.id, 'end')
              editor.focus()
            })
          },
        }))
        if (!query) return combineByGroup(defaultItems, mathItems, diagramItems, aiItems)
        const q = query.toLowerCase()
        return combineByGroup(defaultItems, mathItems, diagramItems, aiItems).filter(i =>
          i.title?.toLowerCase().includes(q) ||
          (i.aliases || []).some((a: string) => a.includes(q))
        )
      }}
    />
  </BlockNoteView>
}

/** Open an external URL: native uses the system opener (tauri-plugin-opener →
 *  macOS `open` → default browser); web falls back to window.open. Same user
 *  behavior on both runtimes (ADR D10 parity). */
async function openExternal(url: string) {
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
  } catch {
    window.open(url, '_blank')
  }
}

/** Shared link URL/text form — submits AS-TYPED (no https:// forcing).
 *  BlockNote's default EditLinkMenuItems.validateUrl prepends
 *  DEFAULT_LINK_PROTOCOL ("https") to any URL without a known scheme, which
 *  mangles vault-relative links: "./folder.md" → "https://./folder.md".
 *  Vault links must round-trip verbatim; bare web domains pasted into the
 *  editor are still https-ified by BlockNote's pasteHandler, so the form
 *  never needs to force a protocol. */
function LinkUrlForm({ url, text, range, showTextField, onSubmitted }: {
  url: string
  text: string
  range: { from: number; to: number }
  showTextField?: boolean
  onSubmitted: () => void
}) {
  const Components = useComponentsContext()!
  const { editLink } = useExtension(LinkToolbarExtension)
  const [currentUrl, setCurrentUrl] = useState(url)
  const [currentText, setCurrentText] = useState(text)
  useEffect(() => { setCurrentUrl(url); setCurrentText(text) }, [url, text])
  const submit = () => {
    editLink(currentUrl.trim(), currentText, range.from)
    onSubmitted()
  }
  return (
    <Components.Generic.Form.Root>
      <Components.Generic.Form.TextInput className="bn-text-input" name="url" icon={<Link2 size={14} />} autoFocus
        placeholder="https://… or ./folder.md" value={currentUrl}
        onChange={e => setCurrentUrl(e.currentTarget.value)}
        onSubmit={submit}
        onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }} />
      {showTextField !== false && (
        <Components.Generic.Form.TextInput className="bn-text-input" name="title" icon={<Type size={14} />}
          placeholder="Text" value={currentText}
          onChange={e => setCurrentText(e.currentTarget.value)}
          onSubmit={submit}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }} />
      )}
    </Components.Generic.Form.Root>
  )
}

/** LinkToolbar "Edit" — preserves the URL as-typed (vault-relative links). */
function EditLinkButtonPreserveUrl({ url, text, range, setToolbarOpen, setToolbarPositionFrozen }: Pick<LinkToolbarProps, 'url' | 'text' | 'range' | 'setToolbarOpen' | 'setToolbarPositionFrozen'>) {
  const Components = useComponentsContext()!
  return (
    <Components.Generic.Popover.Root onOpenChange={setToolbarPositionFrozen}>
      <Components.Generic.Popover.Trigger>
        <Components.LinkToolbar.Button className="bn-button" mainTooltip="Edit link" isSelected={false}>
          Edit
        </Components.LinkToolbar.Button>
      </Components.Generic.Popover.Trigger>
      <Components.Generic.Popover.Content className="bn-popover-content bn-form-popover" variant="form-popover">
        <LinkUrlForm url={url} text={text} range={range}
          onSubmitted={() => { setToolbarOpen?.(false); setToolbarPositionFrozen?.(false) }} />
      </Components.Generic.Popover.Content>
    </Components.Generic.Popover.Root>
  )
}

/** Formatting-toolbar "Link" button (and Ctrl/Cmd+K) — same as-typed form.
 *  Replaces BlockNote's CreateLinkButton, which routes through the
 *  https-forcing EditLinkMenuItems. */
function CreateLinkButtonPreserveUrl() {
  const editor = useBlockNoteEditor<any, any, any>()
  const Components = useComponentsContext()!
  const formattingToolbar = useExtension(FormattingToolbarExtension)
  const { showSelection } = useExtension(ShowSelectionExtension)
  const [showPopover, setShowPopover] = useState(false)
  /** Keep the text selection while the popover is open (correct link range). */
  useEffect(() => {
    showSelection(showPopover, "createLinkButton")
    return () => showSelection(false, "createLinkButton")
  }, [showPopover, showSelection])
  const state = useEditorState({
    editor,
    selector: ({ editor }) => {
      if (!editor.isEditable) return undefined
      return {
        url: editor.getSelectedLinkUrl() ?? '',
        text: editor.getSelectedText(),
        range: {
          from: editor.prosemirrorState.selection.from,
          to: editor.prosemirrorState.selection.to,
        },
      }
    },
  })
  useEffect(() => { setShowPopover(false) }, [state])
  /** Ctrl/Cmd+K opens the link form (same shortcut as the default button). */
  useEffect(() => {
    const el = editor.domElement
    if (!el) return
    const cb = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); setShowPopover(true) }
    }
    el.addEventListener('keydown', cb)
    return () => el.removeEventListener('keydown', cb)
  }, [editor])
  if (state === undefined) return null
  return (
    <Components.Generic.Popover.Root open={showPopover} onOpenChange={setShowPopover}>
      <Components.Generic.Popover.Trigger>
        <Components.FormattingToolbar.Button className="bn-button" label="Link" mainTooltip="Link"
          secondaryTooltip="⌘K" icon={<Link2 size={14} />}
          onClick={() => setShowPopover(o => !o)} />
      </Components.Generic.Popover.Trigger>
      <Components.Generic.Popover.Content className="bn-popover-content bn-form-popover w-[300px]" variant="form-popover">
        <LinkUrlForm url={state.url} text={state.text} range={state.range} showTextField={false}
          onSubmitted={() => { setShowPopover(false); formattingToolbar.store.setState(false) }} />
        <NoteLinkSearch onPick={(title) => {
          try { editor.insertInlineContent([{ type: 'text', text: `[[${title}]]`, styles: {} }] as any) } catch (e) { console.error('insert wikilink:', e) }
          setShowPopover(false); formattingToolbar.store.setState(false)
        }} />
      </Components.Generic.Popover.Content>
    </Components.Generic.Popover.Root>
  )
}

/** LinkToolbar override: "open" on a link pointing to a vault note (relative
 *  path, no scheme) opens the file in the app — not a browser tab. External
 *  URLs open via the system opener (native) / new tab (web).
 *  Edit preserves the URL as-typed (vault-relative links stay intact). */
function WikiLinkToolbar({ url, text, range, setToolbarOpen, setToolbarPositionFrozen }: LinkToolbarProps) {
  const Components = useComponentsContext()!
  const openFile = useEditorStore(s => s.openFile)
  const activeTab = useEditorStore(s => s.activeTab)
  /** Vault link = no scheme and not protocol-relative (//host). Covers plain
   *  names, ./ and ../ (resolved against the ACTIVE file's folder — Obsidian
   *  semantics, NOT the vault root), and / (vault root). Absolute filesystem
   *  paths are excluded (no scheme check above rejects them; the server's
   *  safe_path also guards against any traversal). */
  const isVaultLink = !!url && !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('//')
  const open = () => {
    if (!url) return
    if (!isVaultLink) { openExternal(url); return }
    const target = url.split('#')[0].split('?')[0]   // strip #anchor / ?query
    if (!target) return                              // anchor-only link
    const curFile = activeTab ?? ''
    const curDir = curFile.includes('/') ? curFile.substring(0, curFile.lastIndexOf('/')) : ''
    const resolved = target.startsWith('/')
      ? target.replace(/^\/+/, '')                   // /path → vault root
      : (() => {
          const parts: string[] = []
          for (const seg of [curDir, target].filter(Boolean).join('/').split('/')) {
            if (seg === '..') parts.pop()
            else if (seg === '.' || seg === '') continue
            else parts.push(seg)
          }
          return parts.join('/')
        })()
    openFile(resolved, target.split('/').pop() || resolved)
  }
  return (
    <Components.LinkToolbar.Root className="bn-toolbar bn-link-toolbar">
      <Components.LinkToolbar.Button
        mainTooltip="Open"
        label="Open"
        isSelected={false}
        onClick={open}
        icon={<ExternalLink size={14} />}
      />
      <EditLinkButtonPreserveUrl url={url} text={text} range={range} setToolbarOpen={setToolbarOpen} setToolbarPositionFrozen={setToolbarPositionFrozen} />
      <DeleteLinkButton range={range} setToolbarOpen={setToolbarOpen} />
    </Components.LinkToolbar.Root>
  )
}

/** Formatting toolbar (bubble menu) with the xl-ai button — shows the AI text prompt when text is selected. */
const FormattingToolbarWithAI = () => (
  <FormattingToolbar>
    {getFormattingToolbarItems().filter(el => (el as any).key !== 'createLinkButton')}
    <CreateLinkButtonPreserveUrl />
    <AIToolbarButton />
  </FormattingToolbar>
)

/** "Link a note" — search vault notes (name + content via wiki_suggest) and
 *  pick → caller inserts a `[[wikilink]]`. Lives inside the merged link popover
 *  (one bubble-menu icon), not a separate button. */
function NoteLinkSearch({ onPick }: { onPick: (title: string) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ path: string; title: string }[]>([])
  const [selected, setSelected] = useState(0)

  useEffect(() => {
    if (!query.trim()) { setResults([]); return }
    const t = setTimeout(() => {
      invoke<string>('wiki_suggest', { query: query.trim() }).then(s => {
        try { setResults(JSON.parse(s)); setSelected(0) } catch {}
      }).catch(() => {})
    }, 150)
    return () => clearTimeout(t)
  }, [query])

  return (
    <div className="border-t border-border-subtle px-3 py-2">
      <div className="text-[10px] text-muted uppercase tracking-wider mb-1">or link a vault note</div>
      <input type="text" value={query} onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && results[selected]) { e.preventDefault(); onPick(results[selected].title) }
          if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(i => Math.min(i + 1, results.length - 1)) }
          if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(i => Math.max(i - 1, 0)) }
        }}
        placeholder="Search notes to link…"
        className="w-full bg-transparent border-b border-border px-1 py-1 text-sm text-foreground outline-none" />
      <div className="max-h-[160px] overflow-y-auto mt-1">
        {results.length === 0 && query && <div className="px-1 py-1 text-xs text-muted">No notes found</div>}
        {results.map((r, i) => (
          <div key={r.path} onClick={() => onPick(r.title)} onMouseEnter={() => setSelected(i)}
            className={'px-1 py-1 text-sm cursor-pointer rounded ' + (i === selected ? 'bg-surface-active text-foreground' : 'text-foreground-secondary')}>
            {r.title}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Plain text viewer for non-markdown files. */
function PlainTextViewer({ content, fileName }: { content: string; fileName: string }) {
  return (
    <>
      <div className="text-[11px] text-zinc-600 font-mono uppercase tracking-wider mb-4">{fileName}</div>
      <pre className="text-sm text-foreground-secondary font-mono leading-relaxed whitespace-pre-wrap pt-4">{content}</pre>
    </>
  )
}

/** Raw markdown textarea editor (code mode). */
function MarkdownEditor({ content, onChange }: { content: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  // Auto-resize: grow with content so only the outer container scrolls.
  useEffect(() => {
    const el = ref.current
    if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' }
  }, [content])
  return (
    <textarea ref={ref} value={content} onChange={e => onChange(e.target.value)}
      placeholder="Start writing in Markdown…"
      className="w-full bg-transparent text-sm text-foreground font-mono leading-relaxed outline-none resize-none placeholder:text-zinc-600 pt-4"
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
  /** Only .md files can toggle Editor ↔ Code; others are preview. */
  const toggleable = file ? fileKind(file.path) === 'wysiwyg' : false
  /** AI available only in Editor (WYSIWYG) mode — BlockNote must be mounted. */
  const aiAvailable = file ? fileKind(file.path) === 'wysiwyg' && editMode === 'editor' : false

  /** Subscribe to activeTab separately for tab-switch effect */
  const curTab = useEditorStore(s => s.activeTab)

  useEffect(() => {
    /** Reset disk-dirty on tab switch; next git poll corrects it */
    setHasDiskChanges(false)
  }, [curTab])

  /** Git status: shared store (single poller from App root) — derive per-tab state. */
  const gitStatus = useGitStatus(s => s.status)
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
      const msg = `Auto-commit: ${rawName.replace(/[\x00-\x1f\x7f]/g, '').replace(/\.+$/g, '').trim() || 'changes'}`
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
    <div className="ui-shell h-12 bg-surface border-b border-border-subtle flex items-center gap-3 shrink-0 text-xs px-12">
      <span className="tip-wrap tip-bar">
        <button onClick={() => undo()} disabled={!canUndo} className="rounded cursor-pointer text-zinc-500 hover:text-foreground-secondary hover:bg-surface-active disabled:opacity-30 disabled:cursor-not-allowed p-2"><Undo2 size={16} /></button>
        <span className="tip">Undo <kbd><Command size={11} />Z</kbd></span>
      </span>
      <span className="tip-wrap tip-bar">
        <button onClick={() => redo()} disabled={!canRedo} className="rounded cursor-pointer text-zinc-500 hover:text-foreground-secondary hover:bg-surface-active disabled:opacity-30 disabled:cursor-not-allowed p-2"><Redo2 size={16} /></button>
        <span className="tip">Redo <kbd><Command size={11} /><ArrowBigUp size={11} />Z</kbd></span>
      </span>
      <div className="flex items-stretch h-full overflow-x-auto overflow-y-hidden scrollbar-none">
        {tabs.length === 0 ? <span className="text-zinc-500 italic self-center">No file open</span> : tabs.map(tab => (
          <div key={tab.path} onClick={() => switchTab(tab.path)}
            className={'tab-item flex items-center justify-center relative px-8 cursor-pointer border-r border-border-subtle whitespace-nowrap shrink-0 ' + (activeTab === tab.path ? 'tab-active bg-background text-foreground shadow-[inset_0_-1px_0_var(--color-accent)]' : 'tab-inactive text-foreground-subtle')}>
            <span className={tab.deleted ? 'line-through opacity-50' : undefined}>{tab.name}</span>
            {activeTab === tab.path && (
              <button onClick={e => { e.stopPropagation(); closeTab(tab.path) }} className="tab-close-btn absolute right-2 border-none bg-transparent cursor-pointer p-1 rounded text-foreground-subtle transition-opacity"><X size={14} /></button>
            )}
          </div>
        ))}
      </div>
      <div className="flex-1" />
      <span className="tip-wrap tip-bar">
        <button onClick={onAiToggle} disabled={!aiAvailable}
        className="rounded text-xs flex items-center gap-1 disabled:opacity-30 disabled:cursor-not-allowed enabled:cursor-pointer enabled:text-foreground-subtle enabled:hover:text-foreground enabled:hover:bg-surface-active p-2"><Sparkles size={14} /></button>
        <span className="tip">{!file ? 'Open a file first' : !aiAvailable && fileKind(file.path) === 'wysiwyg' ? 'Switch to Editor for AI' : aiAvailable ? 'Ask AI / Write with AI' : 'AI works on .md files'} <kbd><ChevronUp size={10} /><Option size={10} />L</kbd></span>
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
        disabled={!(hasDiskChanges || hasUnsaved) || file?.deleted}
        className="rounded cursor-pointer text-xs text-foreground-subtle hover:text-foreground hover:bg-surface-active disabled:opacity-30 disabled:cursor-not-allowed p-2">Save</button>
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
/** Extensions that support Editor + Code modes (toggleable). */
const MD_EXTENSION = '.md'
/** Classify a file: 'wysiwyg' (.md — toggleable), 'preview' (others). */
const fileKind = (path: string): 'wysiwyg' | 'preview' => {
  if (path.endsWith(MD_EXTENSION)) return 'wysiwyg'
  return 'preview'
}

export default function Editor() {
  const { editMode } = useEditorStore()
  const file = useEditorStore(s => s.tabs.find(t => t.path === s.activeTab))
  const vaultOpen = useVaultStore(s => s.isOpen)
  const [onboardingDone, setOnboardingDone] = useState(() => isOnboardingDone())

  // Re-check when vault first opens
  useEffect(() => {
    if (vaultOpen && !isOnboardingDone()) setOnboardingDone(false)
  }, [vaultOpen])

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
      /** Only .md files toggle; others are preview. */
      if (active && fileKind(active.path) === 'wysiwyg') s.toggleEditMode()
    }
    if (e.ctrlKey && e.altKey && (e.code === 'KeyL' || e.key === 'l' || e.key === 'L')) {
      e.preventDefault(); openXlAiMenu()
    }
  })

  if (!file) {
    if (!onboardingDone && vaultOpen) {
      return (
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          <TabBar onAiToggle={() => {}} />
          <OnboardingGuide onDismiss={() => setOnboardingDone(true)} />
        </div>
      )
    }

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
  } else if (editMode === 'code') {
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
