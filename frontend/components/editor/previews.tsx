/** Non-editor file previews — binary (image → inline) and plain text. */
import { useEffect, useState, useRef } from 'react'
import { EyeOff } from 'lucide-react'
import { fileUrl } from '../../lib/ipc'

/** ── Non-text preview fallback ── */

/** Image file preview — render the image inline instead of the EyeOff placeholder. */
export function ImagePreview({ fileName, vaultPath, relPath }: { fileName: string; vaultPath: string; relPath: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    fileUrl(vaultPath, relPath).then(u => { if (alive) setSrc(u) }).catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [vaultPath, relPath])
  if (failed) return <PreviewFallback fileName={fileName} />
  if (!src) return <div className="h-full flex items-center justify-center text-zinc-500 text-sm italic">Loading...</div>
  return (
    <div className="h-full w-full flex items-center justify-center p-6 overflow-auto">
      <img src={src} alt={fileName} className="max-w-full max-h-full object-contain rounded-md" onError={() => setFailed(true)} />
    </div>
  )
}

/** Fallback UI for binary file types that can't be previewed as text. */
function PreviewFallback({ fileName }: { fileName: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-zinc-500 gap-3">
      <EyeOff size={32} strokeWidth={1.5} />
      <span className="text-sm"><span className="text-foreground-subtle">{fileName}</span> — preview only</span>
    </div>
  )
}
/** Plain text viewer for non-markdown files. */
export function PlainTextViewer({ content, fileName }: { content: string; fileName: string }) {
  return (
    <>
      <div className="text-[11px] text-zinc-600 font-mono uppercase tracking-wider mb-4">{fileName}</div>
      <pre className="text-sm text-foreground-secondary font-mono leading-relaxed whitespace-pre-wrap pt-4">{content}</pre>
    </>
  )
}

/** Raw markdown textarea editor (code mode). */
export function MarkdownEditor({ content, onChange }: { content: string; onChange: (v: string) => void }) {
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
