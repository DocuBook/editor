import { useEffect, useLayoutEffect, useState } from 'react'
import { WysiwygEditor } from './WysiwygEditor'
import { getCachedEditor, peekCachedEditor, type CachedEditor } from '../../utils/editorFactory'
import { readWysiwygSnapshot } from '../../utils/wysiwygSnapshot'

type Entry = { vaultPath: string; filePath: string; cached: CachedEditor }

/** Keep editor instances alive without putting BlockNote in initial app chunk.
 *
 *  A cache hit is resolved SYNCHRONOUSLY on the first render (peek): a tab
 *  switch then paints the existing instance straight away instead of showing a
 *  loading placeholder while an effect looks up what is already in memory. The
 *  effect below only runs for a genuine miss — the first open of that file —
 *  and creates the instance WITH its markdown, so that first paint is the note
 *  itself and not BlockNote's empty document (which paints its placeholder
 *  until the parse lands; see editorFactory.loadMarkdownIntoEditor). */
export default function WysiwygEditorHost({ vaultPath, filePath, isDesktop, markdown, cursorOffset, onCursorOffset, onSync }: {
  vaultPath: string
  filePath: string
  isDesktop: boolean
  markdown: string
  cursorOffset?: number
  onCursorOffset: (offset: number) => void
  onSync: (md: string) => void
}) {
  const [entry, setEntry] = useState<Entry | null>(() => {
    const cached = peekCachedEditor(vaultPath, filePath)
    return cached ? { vaultPath, filePath, cached } : null
  })
  const ready = entry?.vaultPath === vaultPath && entry.filePath === filePath ? entry.cached : null

  /* The editor view is mounted only by a SYNC-lane commit — one scheduled from
   * this layout effect, which React commits before the browser paints.
   *
   * BlockNote mounts ProseMirror in a ref callback (layout phase). Every
   * math / diagram / code block node view then attaches its editable source
   * (the contentDOM, i.e. the raw LaTeX / Mermaid / code text) straight into
   * the page, and queues its React render on a microtask. That render reaches
   * the screen through BlockNote's `Portals`, whose store subscription is a
   * PASSIVE effect. React flushes passive effects synchronously only after a
   * sync-lane commit; after any other commit it defers them past the next
   * paint. The cold open is such a commit — `setEntry` runs after an await —
   * so the queued renders found no subscriber, and the browser painted every
   * source block as its bare source text until the deferred effect subscribed
   * and rendered the previews (one frame; on a long note, hundreds of ms).
   *
   * Gating the mount behind a layout-effect update makes the commit that runs
   * `editor.mount` a sync one whatever scheduled the host — a cold open after
   * the snapshot read, or a cached tab activated from async code. Nothing is
   * painted in between: the empty commit and the sync re-render both complete
   * before the frame. */
  const [mounted, setMounted] = useState<CachedEditor | null>(null)
  /* oxlint-disable react/set-state-in-effect -- the sync-lane mount gate described above */
  useLayoutEffect(() => {
    if (ready) setMounted(ready)
  }, [ready])
  /* oxlint-enable react/set-state-in-effect */

  /* oxlint-disable react/set-state-in-effect -- creates the editor for a cache miss after mount */
  useEffect(() => {
    if (ready) return
    let cancelled = false
    /* Read the WYSIWYG-only snapshot BEFORE creating the instance, so the first
     * paint already carries the formatting Markdown drops. A miss — or a read
     * that outlives this mount — falls back to the plain markdown seed. */
    void (async () => {
      const snapshot = await readWysiwygSnapshot(filePath)
      if (cancelled) return
      setEntry({ vaultPath, filePath, cached: getCachedEditor(vaultPath, filePath, markdown, snapshot) })
    })()
    return () => { cancelled = true }
  }, [ready, vaultPath, filePath, markdown])
  /* oxlint-enable react/set-state-in-effect */

  if (!ready) return <div className="h-full flex items-center justify-center text-foreground-subtle text-sm italic">Loading editor...</div>
  if (mounted !== ready) return null
  return <WysiwygEditor cached={ready} filePath={filePath} isDesktop={isDesktop} markdown={markdown} cursorOffset={cursorOffset} onCursorOffset={onCursorOffset} onSync={onSync} />
}
