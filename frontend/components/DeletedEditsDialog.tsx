import { useEffect } from 'react'

import { useEditorStore } from '../stores/editor'

/** Asks what to do with edits typed into tabs whose file was deleted.
 *
 *  Closing the tab or quitting would drop them, because every save path skips a
 *  deleted tab. Save recreates the file at the same path (and turns into a
 *  conflict if a file has come back there); Discard drops the edits. */
export default function DeletedEditsDialog() {
  const prompt = useEditorStore(state => state.deletedPrompt)
  const answer = useEditorStore(state => state.answerDeletedPrompt)

  useEffect(() => {
    if (!prompt) return
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') answer('cancel') }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [prompt, answer])

  if (!prompt) return null
  const [first] = prompt.names
  const many = prompt.names.length > 1
  return (
    <div role="alertdialog" aria-modal="true" aria-label="Deleted file has unsaved changes" className="fixed inset-0 z-220 flex items-center justify-center ui-backdrop" onClick={() => answer('cancel')}>
      <div className="ui-popover p-4 w-80" onClick={e => e.stopPropagation()}>
        <div className="text-sm font-semibold mb-1">{many ? `${prompt.names.length} deleted files have unsaved changes` : `"${first}" was deleted`}</div>
        <div className="text-xs text-foreground-secondary mb-4">
          {many ? `${prompt.names.join(', ')} were deleted after you started editing them. ` : 'You edited it after it was deleted. '}
          Save to recreate {many ? 'them' : 'it'}, or discard your changes.
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={() => answer('cancel')} className="text-xs px-3 py-1.5 rounded border border-border-subtle bg-transparent text-foreground-secondary cursor-pointer hover:bg-surface-active">Cancel</button>
          <button onClick={() => answer('discard')} className="text-xs px-3 py-1.5 rounded bg-danger text-on-danger cursor-pointer border-none">Discard</button>
          <button autoFocus onClick={() => answer('save')} className="text-xs px-3 py-1.5 rounded border border-border-subtle bg-surface-active text-foreground cursor-pointer">Save</button>
        </div>
      </div>
    </div>
  )
}
