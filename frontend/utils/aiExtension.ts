import { Decoration, DecorationSet } from 'prosemirror-view'
import { Plugin, PluginKey } from 'prosemirror-state'
import { createAiTransport } from './aiTransport'
import { buildHtmlDocumentState, hasAISelection, restoreAISelection } from './aiBlocks'
import { uuid } from './uuid'

export type AiMenuState =
  | { blockId: string; status: 'user-input' | 'thinking' | 'ai-writing' | 'user-reviewing' | 'error'; error?: any }
  | 'closed'

type InvokeOptions = { userPrompt: string; useSelection?: boolean }

const pluginKey = new PluginKey('docubook-ai')

const toolSchema = {
  type: 'object',
  properties: {
    operations: {
      type: 'array',
      items: {
        anyOf: [
          { type: 'object', properties: { type: { type: 'string', enum: ['update'] }, id: { type: 'string' }, block: { type: 'string' } }, required: ['type', 'id', 'block'], additionalProperties: false },
          { type: 'object', properties: { type: { type: 'string', enum: ['add'] }, referenceId: { type: 'string' }, position: { type: 'string', enum: ['before', 'after'] }, blocks: { type: 'array', items: { type: 'string' } } }, required: ['type', 'referenceId', 'position', 'blocks'], additionalProperties: false },
          { type: 'object', properties: { type: { type: 'string', enum: ['delete'] }, id: { type: 'string' } }, required: ['type', 'id'], additionalProperties: false },
        ],
      },
    },
  },
  required: ['operations'],
  additionalProperties: false,
}

function createStore<T>(initialState: T) {
  let state = initialState
  const listeners = new Set<() => void>()
  return {
    get state() { return state },
    setState(next: T) { state = next; listeners.forEach((listener) => listener()) },
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
  }
}

function cleanId(id: unknown) {
  return typeof id === 'string' ? id.replace(/\$$/, '') : ''
}

/** Apply tool operations and report every block the agent wrote, in operation
 *  order — the reveal walks them and the caret is parked at the last one
 *  (the `agentCursor` contract). */
function applyOperations(editor: any, input: any): string[] {
  if (!Array.isArray(input?.operations)) throw new Error('AI tool input must contain operations')
  const written: string[] = []
  editor.transact(() => {
    for (const operation of input.operations) {
      if (operation?.type === 'update') {
        const id = cleanId(operation.id)
        if (!id || !editor.getBlock(id)) throw new Error('Referenced document block is no longer available')
        const blocks = editor.tryParseHTMLToBlocks(operation.block)
        if (!blocks.length) throw new Error('AI returned invalid HTML block')
        editor.updateBlock(id, { ...blocks[0], id: undefined, children: undefined })
        written.push(id)
      } else if (operation?.type === 'add') {
        const id = cleanId(operation.referenceId)
        if (!id || !editor.getBlock(id)) throw new Error('Referenced document block is no longer available')
        const blocks = (operation.blocks || []).flatMap((html: string) => editor.tryParseHTMLToBlocks(html).map((block: any) => ({ ...block, id: undefined, children: undefined })))
        if (blocks.length) {
          const inserted = editor.insertBlocks(blocks, id, operation.position) || []
          for (const block of inserted) written.push(block.id)
        }
      } else if (operation?.type === 'delete') {
        const id = cleanId(operation.id)
        if (!id || !editor.getBlock(id)) throw new Error('Referenced document block is no longer available')
        editor.removeBlocks([id])
      }
    }
  })
  return written
}

/** Character-reveal pacing for freshly written AI content. The document is
 *  already final when the reveal starts: this only grows the visible prefix and
 *  moves the caret with it, so skipping the animation never changes what is
 *  saved, undone or accepted. Pacing is bounded on both ends so a huge response
 *  cannot stall the review step. */
const REVEAL_MS_PER_CHAR = 6
const REVEAL_MIN_MS = 350
const REVEAL_MAX_MS = 2200
const REVEAL_FRAME_MS = 1000 / 60
/** Waiting text is hidden with `visibility` (not `display`), so the final
 *  layout — including the caret's travel path — exists from the first frame and
 *  a tall block never reflows while it is being written. */
const REVEAL_HIDDEN_CLASS = 'ai-reveal-hidden'

function prefersReducedMotion() {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/** Inline content range of a block: what the reveal hides and where the caret
 *  sits while the block is being written. */
function blockContentRange(doc: any, id: string): { from: number; to: number } | null {
  let range: { from: number; to: number } | null = null
  doc.descendants((node: any, nodePos: number) => {
    if (range) return false
    if (node.attrs?.id !== id) return true
    range = { from: nodePos + 1, to: nodePos + node.nodeSize - 1 }
    return false
  })
  return range
}

type RevealSpan = { from: number; to: number }

type RevealState = {
  spans: RevealSpan[]
  budget: number
  total: number
  raf: number
  finish: () => void
  done: Promise<void>
}

/** rust-ai: the writing caret is a `.bn-collaboration-cursor__base[data-active="true"]`
 *  element carrying a `.bn-collaboration-cursor__label`, wrapped in word joiners.
 *  `aiFollowScroll`, the `#root` label override in index.css and the pre-flicker
 *  e2e suite all key off that exact DOM contract. */
function createAgentCursor({ name, color }: { name?: string; color?: string }) {
  const accent = color || 'var(--color-ai-cursor)'
  const cursor = document.createElement('span')
  cursor.classList.add('bn-collaboration-cursor__base')
  cursor.setAttribute('data-active', 'true')
  const caret = document.createElement('span')
  caret.classList.add('bn-collaboration-cursor__caret')
  caret.setAttribute('contenteditable', 'false')
  caret.setAttribute('style', `background-color: ${accent}`)
  const label = document.createElement('span')
  label.classList.add('bn-collaboration-cursor__label')
  label.setAttribute('style', `background-color: ${accent}`)
  label.textContent = name || 'AI'
  caret.appendChild(label)
  cursor.appendChild(document.createTextNode('\u2060'))
  cursor.appendChild(caret)
  cursor.appendChild(document.createTextNode('\u2060'))
  return cursor
}

/** Document position at the end of a block's content — where the caret sits. */
function blockEndPos(doc: any, id: string): number | null {
  let pos: number | null = null
  doc.descendants((node: any, nodePos: number) => {
    if (pos !== null) return false
    if (node.attrs?.id !== id) return true
    const inner = node.firstChild
    pos = inner ? nodePos + 1 + inner.nodeSize - 1 : nodePos + node.nodeSize - 1
    return false
  })
  return pos
}

function readPart(value: any) {
  const parts = Array.isArray(value) ? value : [value]
  return parts.find((part) => part?.type === 'tool-input-available')?.input
}

const extensionFactory = ({ editor, options }: any) => {
  const store = createStore<{ aiMenuState: AiMenuState }>({ aiMenuState: 'closed' })
  const agentCursor = options?.agentCursor ?? {}
  let session: { options: InvokeOptions; controller: AbortController; before: any[] } | undefined
  /** Live position of the streaming caret, or null when nothing is being written. */
  let writingPos: number | null = null
  /** Non-null while freshly written content is being revealed character by
   *  character; `budget` counts revealed characters across `spans`. */
  let reveal: RevealState | null = null

  /** Absolute document position of the reveal frontier for a character budget. */
  const revealFrontier = (spans: RevealSpan[], budget: number) => {
    let remaining = budget
    for (const span of spans) {
      const length = span.to - span.from
      if (remaining < length) return span.from + remaining
      remaining -= length
    }
    return spans.length ? spans[spans.length - 1].to : 0
  }

  const cancelReveal = () => {
    if (!reveal) return
    if (reveal.raf) cancelAnimationFrame(reveal.raf)
    const { finish } = reveal
    reveal = null
    refreshDecorations()
    finish()
  }

  /** Reveal the blocks an operation just wrote. Never throws and never blocks
   *  the transport: a skipped reveal (reduced motion, background tab, deleted
   *  blocks) simply leaves the final content visible right away. */
  const startReveal = (ids: string[]) => {
    if (reveal) cancelReveal()
    const doc = (editor as any).prosemirrorView?.state.doc
    if (!doc || prefersReducedMotion() || document.hidden) return
    const spans = ids
      .map((id) => blockContentRange(doc, id))
      .filter((span): span is RevealSpan => !!span && span.to > span.from)
      .sort((a, b) => a.from - b.from)
    const total = spans.reduce((sum, span) => sum + (span.to - span.from), 0)
    if (!total) return
    const duration = Math.min(REVEAL_MAX_MS, Math.max(REVEAL_MIN_MS, total * REVEAL_MS_PER_CHAR))
    const perFrame = Math.max(1, Math.ceil(total / Math.max(1, Math.round(duration / REVEAL_FRAME_MS))))
    let finish: () => void = () => {}
    const done = new Promise<void>((resolve) => { finish = resolve })
    const state: RevealState = { spans, budget: 0, total, raf: 0, finish, done }
    const lastId = ids[ids.length - 1] ?? null
    const step = () => {
      if (reveal !== state) return
      state.budget = Math.min(total, state.budget + perFrame)
      if (state.budget >= total) {
        reveal = null
        moveWritingCursor(lastId)
        finish()
        return
      }
      refreshDecorations()
      state.raf = requestAnimationFrame(step)
    }
    reveal = state
    refreshDecorations()
    state.raf = requestAnimationFrame(step)
  }

  /** Wait out the reveal, bounded so a stalled frame loop can never hold the
   *  review step hostage. */
  const waitForReveal = async () => {
    const pending = reveal?.done
    if (!pending) return
    await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, REVEAL_MAX_MS + 800))])
  }

  /** Decorations recompute only on transactions, so an empty one is dispatched
   *  whenever the caret moves or disappears. */
  const refreshDecorations = () => {
    const view = (editor as any).prosemirrorView
    if (view) view.dispatch(view.state.tr)
  }

  const moveWritingCursor = (blockId: string | null | undefined) => {
    const doc = (editor as any).prosemirrorView?.state.doc
    writingPos = blockId && doc ? blockEndPos(doc, blockId) : null
    refreshDecorations()
  }

  const clearWritingCursor = () => {
    if (writingPos === null) return
    writingPos = null
    refreshDecorations()
  }

  const setStatus = (status: any) => {
    const current = store.state.aiMenuState
    if (current === 'closed') return
    const next = typeof status === 'object' ? { ...status, blockId: current.blockId } : { status, blockId: current.blockId }
    if (next.status !== 'ai-writing') clearWritingCursor()
    store.setState({ aiMenuState: next })
  }

  const close = () => {
    session = undefined
    cancelReveal()
    clearWritingCursor()
    editor.getExtension('showSelection')?.showSelection?.(false, 'aiMenu')
    editor.isEditable = true
    store.setState({ aiMenuState: 'closed' })
    editor.focus()
  }

  const reject = () => {
    if (session?.before) editor.replaceBlocks(editor.document.map((block: any) => block.id), session.before)
    close()
  }

  return {
    key: 'ai',
    store,
    prosemirrorPlugins: [new Plugin({
      key: pluginKey,
      props: {
        decorations: (state) => {
          /** While revealing, the caret rides the frontier and everything past it
           *  stays hidden — the text is already in the document, only its
           *  visibility grows. */
          if (reveal) {
            const frontier = revealFrontier(reveal.spans, reveal.budget)
            if (frontier > state.doc.content.size) return DecorationSet.empty
            const decorations = reveal.spans
              .filter((span) => Math.max(span.from, frontier) < span.to)
              .map((span) => Decoration.inline(Math.max(span.from, frontier), span.to, { class: REVEAL_HIDDEN_CLASS }))
            decorations.push(Decoration.widget(frontier, () => createAgentCursor(agentCursor), { key: 'docubook-ai-cursor', side: 10, ignoreSelection: true }))
            return DecorationSet.create(state.doc, decorations)
          }
          if (writingPos === null || writingPos > state.doc.content.size) return DecorationSet.empty
          return DecorationSet.create(state.doc, [
            Decoration.widget(writingPos, () => createAgentCursor(agentCursor), { key: 'docubook-ai-cursor', side: 10, ignoreSelection: true }),
          ])
        },
      },
    })],
    openAIMenuAtBlock(blockId: string) {
      editor.getExtension('showSelection')?.showSelection?.(true, 'aiMenu')
      editor.isEditable = false
      store.setState({ aiMenuState: { blockId, status: 'user-input' } })
    },
    closeAIMenu: close,
    acceptChanges: close,
    rejectChanges: reject,
    async abort(reason?: any) {
      if (!session) return
      session.controller.abort(reason)
      reject()
    },
    async retry() {
      // The error UI can outlive the session when the editor is closed or the
      // request is aborted. Treat a stale click as a no-op instead of creating
      // an unhandled rejection from the floating composer.
      if (store.state.aiMenuState === 'closed' || store.state.aiMenuState.status !== 'error' || !session) return
      /** Resend the ORIGINAL prompt. The transport sends only the latest user
       *  message (no conversation history), so replacing the prompt with an
       *  error notice left rust-ai with no task — the model then answered
       *  "no last prompt content… cannot retry" instead of redoing the work. */
      return this.invokeAI(session.options)
    },
    setAIResponseStatus: setStatus,
    async invokeAI(invokeOptions: InvokeOptions) {
      const state = store.state.aiMenuState
      if (state === 'closed') return
      const controller = new AbortController()
      const before = editor.document.map((block: any) => ({ ...block, children: block.children?.map((child: any) => ({ ...child })) || [] }))
      session = { options: invokeOptions, controller, before }
      setStatus('thinking')
      try {
        if (invokeOptions.useSelection && hasAISelection(editor) && !restoreAISelection(editor)) throw new Error('Text selection is no longer available')
        /** rust-ai: the canonical document state comes from the injected
         *  builder (selection-aware, windowed) — the local HTML builder is only
         *  the fallback when no builder was configured. */
        const selectedBlocks = invokeOptions.useSelection ? (editor.getSelection?.()?.blocks ?? []) : []
        const documentState = options?.documentStateBuilder
          ? await options.documentStateBuilder({ editor, selectedBlocks })
          : await buildHtmlDocumentState(editor, invokeOptions.useSelection)
        const transport = options?.transport || createAiTransport({ getEditor: () => editor })
        const stream = await transport.sendMessages({
          messages: [{ id: uuid(), role: 'user', parts: [{ type: 'text', text: invokeOptions.userPrompt }], metadata: { documentState } }],
          body: { toolDefinitions: { applyDocumentOperations: { description: 'Apply document operations', inputSchema: toolSchema, outputSchema: { type: 'object' } } } },
          abortSignal: controller.signal,
        })
        const reader = stream.getReader()
        let toolInput: any = null
        while (true) {
          const next = await reader.read()
          if (next.done) break
          const input = readPart(next.value)
          if (!input) continue
          toolInput = input
          setStatus('ai-writing')
          const written = applyOperations(editor, input)
          moveWritingCursor(written[written.length - 1] ?? null)
          startReveal(written)
        }
        if (!toolInput) throw new Error('AI returned no document operations')
        await waitForReveal()
        setStatus('user-reviewing')
      } catch (error) {
        if (controller.signal.aborted) return
        setStatus({ status: 'error', error })
      }
    },
  }
}

export const AIExtension: any = (options?: any) => (ctx: any) => extensionFactory({ ...ctx, options })
