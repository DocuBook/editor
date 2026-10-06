/** Non-editor file previews — binary (image → inline) and plain text. */
import { useEffect, useMemo, useState, useRef, memo } from 'react'
import { EyeOff } from 'lucide-react'
import { fileUrl, mediaErrorMessage, mediaFailureReason } from '../../lib/ipc'
import { highlightMarkdown, markdownTokenClass, type MarkdownToken } from '../../utils/markdownHighlight'
import { softKeyboardOnFocus } from '../../utils/softKeyboard'

/** ── Non-text preview fallback ── */

/** Image file preview — render the image inline instead of the EyeOff placeholder. */
export function ImagePreview({ fileName, vaultPath, relPath }: { fileName: string; vaultPath: string; relPath: string }) {
  const target = JSON.stringify([vaultPath, relPath])
  const [preview, setPreview] = useState<{ target: string; src: string | null; error: string | null } | null>(null)
  useEffect(() => {
    let alive = true
    fileUrl(vaultPath, relPath)
      .then(src => { if (alive) setPreview({ target, src, error: null }) })
      .catch(e => { if (alive) setPreview({ target, src: null, error: mediaErrorMessage(e) }) })
    return () => { alive = false }
  }, [target, vaultPath, relPath])
  const currentPreview = preview?.target === target ? preview : null
  if (currentPreview?.error) return <PreviewFallback fileName={fileName} message={currentPreview.error} />
  if (!currentPreview?.src) return <div className="h-full flex items-center justify-center text-foreground-subtle text-sm italic">Loading...</div>
  return (
    <div className="h-full w-full flex items-center justify-center p-6 overflow-auto">
      {/* Desktop inlines bytes, so a render error here is already recovered by
          fileUrl; on web the <img> fetch is where a 404/403/413 surfaces, and
          this turns the bare error into the real reason. */}
      <img src={currentPreview.src} alt={fileName} className="max-w-full max-h-full object-contain rounded-md" onError={() => {
        void mediaFailureReason(vaultPath, relPath).then(message => {
          setPreview(prev => prev?.target === target ? { ...prev, error: message } : prev)
        })
      }} />
    </div>
  )
}

/** Fallback UI for files that can't be previewed, naming the reason when known. */
function PreviewFallback({ fileName, message }: { fileName: string; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-foreground-subtle gap-3">
      <EyeOff size={32} strokeWidth={1.5} />
      <span className="text-sm"><span className="text-foreground-subtle">{fileName}</span> — {message}</span>
    </div>
  )
}
/** Plain text viewer for non-markdown files. */
export function PlainTextViewer({ content, fileName }: { content: string; fileName: string }) {
  return (
    <>
      <div className="text-[11px] text-muted font-mono uppercase tracking-wider mb-4">{fileName}</div>
      <pre className="text-sm text-foreground-secondary font-mono leading-relaxed whitespace-pre-wrap pt-4">{content}</pre>
    </>
  )
}

/** Colour-only token paint. Nothing here may change weight, style, size or
 *  spacing — only colour and decoration, which do not move glyphs.
 *
 *  Memoised on `tokens`: while a debounced edit is still uncoloured the token
 *  array keeps its identity, so a keystroke does not re-render the span tree
 *  for the whole note. */
const MarkdownTokens = memo(function MarkdownTokens({ tokens }: { tokens: MarkdownToken[] }) {
  return (
    <>
      {tokens.map((token, index) => {
        const className = markdownTokenClass(token.kind)
        if (token.children) {
          return className
            ? <span key={index} className={className}><MarkdownTokens tokens={token.children} /></span>
            : <MarkdownTokens key={index} tokens={token.children} />
        }
        return className ? <span key={index} className={className}>{token.text}</span> : token.text
      })}
    </>
  )
})

/** No tokens yet — a stable identity, so the memo above is not defeated. */
const NO_TOKENS: MarkdownToken[] = []

/** Tokenising is a whole-document micromark parse: linear in the note, and far
 *  from free on a long one (GFM costs several times plain CommonMark). It must
 *  not sit in the keystroke's render path, or the glyph the user just typed
 *  waits on the parser. Short notes tokenise during render — cheap, and the
 *  overlay never trails the text. Long notes are debounced; `pending` reports
 *  that the painted tokens belong to older text, which is unrenderable colour,
 *  not something to show. */
const LIVE_PARSE_LIMIT = 4000
const COLOUR_DELAY_MS = 90

function useMarkdownTokens(source: string) {
  const [painted, setPainted] = useState<{ source: string; tokens: MarkdownToken[] } | null>(null)
  const live = source.length <= LIVE_PARSE_LIMIT
  const liveTokens = useMemo(() => (live ? highlightMarkdown(source) : null), [live, source])
  useEffect(() => {
    if (live || painted?.source === source) return
    const timer = setTimeout(() => setPainted({ source, tokens: highlightMarkdown(source) }), COLOUR_DELAY_MS)
    return () => clearTimeout(timer)
  }, [live, source, painted?.source])
  if (liveTokens) return { tokens: liveTokens, pending: false }
  return { tokens: painted?.tokens ?? NO_TOKENS, pending: painted?.source !== source }
}

/** Raw markdown textarea editor (code mode).
 *
 *  Highlighting is a <pre> painted behind the textarea, so every native
 *  editing behaviour (caret, selection, IME, undo, spellcheck) stays the
 *  browser's. The textarea keeps its own text transparent and shows only the
 *  caret; the exceptions are moments when the layer has nothing truthful to
 *  show — during IME composition the preedit is not in `content` yet, and while
 *  `pending` the tokens describe older text — and the textarea reveals its own
 *  text for the duration instead. */
export function MarkdownEditor({ content, cursorOffset, onCursorOffset, onChange }: {
  content: string
  cursorOffset?: number
  onCursorOffset: (offset: number) => void
  onChange: (v: string) => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const initialCursorOffset = useRef(cursorOffset)
  const [composing, setComposing] = useState(false)
  const { tokens, pending } = useMarkdownTokens(content)
  const revealed = composing || pending
  // Auto-resize before restoring scroll so the outer container has its final height.
  useEffect(() => {
    const el = ref.current
    if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' }
  }, [content])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const offset = Math.min(initialCursorOffset.current ?? 0, el.value.length)
    /* Selection and scroll restore are not typing: on a system whose focus
       raises an on-screen keyboard, focusing at open would raise the IME over a
       note the user only meant to open (and the drawer's exit handoff would
       drop it again). The caret waits for the user's own tap. */
    if (!softKeyboardOnFocus()) el.focus({ preventScroll: true })
    el.setSelectionRange(offset, offset)
    const scroller = el.closest('.editor-content')
    if (scroller) {
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20
      const line = el.value.slice(0, offset).split('\n').length - 1
      // Measured from rects, not offsetTop: the highlight stack is a positioned
      // ancestor, so the textarea's offsetParent is no longer the scroller.
      const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
      scroller.scrollTop = Math.max(0, top + line * lineHeight - scroller.clientHeight / 3)
    }
  }, [initialCursorOffset])
  return (
    <div className="editor-raw-stack relative">
      <pre aria-hidden="true" data-testid="raw-markdown-highlight"
        className={'editor-raw-highlight pointer-events-none absolute inset-0 overflow-hidden' + (pending ? ' invisible' : '')}>
        <MarkdownTokens tokens={tokens} />
      </pre>
      <textarea ref={ref} value={content} onChange={e => { onCursorOffset(e.currentTarget.selectionStart); onChange(e.target.value) }}
        onSelect={e => onCursorOffset(e.currentTarget.selectionStart)}
        onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
        placeholder="Start writing in Markdown…"
        className={'editor-raw-markdown relative block w-full bg-transparent outline-none resize-none placeholder:text-muted ' + (revealed ? 'text-foreground' : 'text-transparent')}
        spellCheck={false} />
    </div>
  )
}
