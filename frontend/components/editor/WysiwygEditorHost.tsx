import { useEffect, useState } from 'react'
import { WysiwygEditor } from './WysiwygEditor'
import { getEditorCache } from '../../utils/editorCache'
import { createBlockEditor, type CachedEditor } from '../../utils/editorFactory'

/** Keep editor instances alive without putting BlockNote in initial app chunk. */
export default function WysiwygEditorHost({ vaultPath, filePath, markdown, onSync }: {
  vaultPath: string
  filePath: string
  markdown: string
  onSync: (md: string) => void
}) {
  const [entry, setEntry] = useState<{ vaultPath: string; filePath: string; cached: CachedEditor } | null>(null)
  const ready = entry?.vaultPath === vaultPath && entry.filePath === filePath ? entry.cached : null

  useEffect(() => {
    let active = true
    const cached = getEditorCache<CachedEditor>(vaultPath, path => createBlockEditor(vaultPath, path)).get(filePath)
    if (active) setEntry({ vaultPath, filePath, cached })
    return () => { active = false }
  }, [vaultPath, filePath])

  if (!ready) return <div className="h-full flex items-center justify-center text-zinc-500 text-sm italic">Loading editor...</div>
  return <WysiwygEditor cached={ready} filePath={filePath} markdown={markdown} onSync={onSync} />
}
