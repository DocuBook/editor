import { useEffect, useRef, useState } from 'react'
import { useEditorStore } from '../stores/editor'
import { useVaultStore } from '../stores/vault'
import OnboardingGuide, { isOnboardingDone, markOnboardingDone } from './OnboardingGuide'
import { useKeyboard } from '../hooks/useKeyboard'
import { editorFileKind } from '../utils/fileKind'
import { WelcomeScreen } from './editor/WelcomeScreen'
import { TabBar } from './editor/TabBar'
import { WysiwygEditor } from './editor/WysiwygEditor'
import { ImagePreview, PlainTextViewer, MarkdownEditor } from './editor/previews'
import { createBlockEditor, KeepAliveCache, type CachedEditor } from '../utils/editorFactory'

/** Keep-alive cache: one BlockNote instance per open file. Survives tab
 *  switches — only the view remounts, the instance (doc, undo history, AI
 *  stream) persists. Reset when the vault changes (rel paths are
 *  vault-scoped). */
function useEditorCache() {
  const cacheRef = useRef<KeepAliveCache<CachedEditor> | null>(null)
  const vaultPath = useVaultStore(s => s.vaultPath)
  if (!cacheRef.current) cacheRef.current = new KeepAliveCache(path => createBlockEditor(vaultPath, path))
  useEffect(() => {
    // Vault changed: stale instances must go (rel paths collide across vaults).
    cacheRef.current!.clear()
  }, [vaultPath])
  const get = (path: string): CachedEditor => cacheRef.current!.get(path)
  return get
}

export default function Editor() {
  const { editMode } = useEditorStore()
  const getCachedEditor = useEditorCache()
  const file = useEditorStore(s => s.tabs.find(t => t.path === s.activeTab))
  const vaultOpen = useVaultStore(s => s.isOpen)
  const vaultPath = useVaultStore(s => s.vaultPath)
  const [onboardingDone, setOnboardingDone] = useState(() => isOnboardingDone())

  // Re-check when vault first opens
  useEffect(() => {
    if (vaultOpen && !isOnboardingDone()) setOnboardingDone(false)
  }, [vaultOpen])

  /** Completion is set by REAL progress, not by clicking the onboarding button:
   *  opening a file proves step 1 (create a note) is done. The button only
   *  dismisses — a reload/new vault still shows the guide until a note exists. */
  useEffect(() => {
    if (file) markOnboardingDone()
  }, [file])

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
      if (active && editorFileKind(active.path) === 'wysiwyg') s.toggleEditMode()
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

    if (!vaultOpen) return <WelcomeScreen />

    return (
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <TabBar onAiToggle={() => {}} />
        <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm italic">Select a file from the sidebar</div>
      </div>
    )
  }

  const kind = editorFileKind(file.path)

  /** Shared scroll container — all modes use the same container. */
  let inner: React.ReactNode
  if (kind === 'binary') {
    inner = <ImagePreview fileName={file.name} vaultPath={vaultPath} relPath={file.path} />
  } else if (file.content == null) {
    inner = <div className="h-full flex items-center justify-center text-zinc-500 text-sm italic">Loading...</div>
  } else if (kind === 'text') {
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
    const cached = getCachedEditor(file.path)
    inner = <WysiwygEditor key={file.path} cached={cached} filePath={file.path} markdown={(file.editedContent ?? file.content).replace(file.frontmatter, '')} onSync={md => useEditorStore.getState().setEditedContent(file.path, md)} />
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