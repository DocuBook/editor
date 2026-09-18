import { useEffect, useState } from 'react'
import { WysiwygEditor } from './WysiwygEditor'
import { getCachedEditor, peekCachedEditor, type CachedEditor } from '../../utils/editorFactory'

type Entry = { vaultPath: string; filePath: string; cached: CachedEditor }

/** Keep editor instances alive without putting BlockNote in initial app chunk.
 *
 *  A cache hit is resolved SYNCHRONOUSLY on the first render (peek): a tab
 *  switch then paints the existing instance straight away instead of showing a
 *  loading placeholder while an effect looks up what is already in memory. The
 *  effect below only runs for a genuine miss — the first open of that file. */
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

  /* oxlint-disable react/set-state-in-effect -- creates the editor for a cache miss after mount */
  useEffect(() => {
    if (ready) return
    setEntry({ vaultPath, filePath, cached: getCachedEditor(vaultPath, filePath) })
  }, [ready, vaultPath, filePath])
  /* oxlint-enable react/set-state-in-effect */

  if (!ready) return <div className="h-full flex items-center justify-center text-foreground-subtle text-sm italic">Loading editor...</div>
  return <WysiwygEditor cached={ready} filePath={filePath} isDesktop={isDesktop} markdown={markdown} cursorOffset={cursorOffset} onCursorOffset={onCursorOffset} onSync={onSync} />
}
