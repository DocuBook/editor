import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { useEditorStore } from '../stores/editor'
import { useVaultStore } from '../stores/vault'
import OnboardingGuide from './OnboardingGuide'
import { isOnboardingDone, markOnboardingDone } from '../utils/onboarding'
import { useKeyboard } from '../hooks/useKeyboard'
import { editorFileKind } from '../utils/fileKind'
import { WelcomeScreen } from './editor/WelcomeScreen'
import { TabBar } from './editor/TabBar'
import { ImagePreview, PlainTextViewer, MarkdownEditor } from './editor/previews'
import { clearEditorCache } from '../utils/editorCache'

const WysiwygEditorHost = lazy(() => import('./editor/WysiwygEditorHost'))

export default function Editor({ sidebarOpen, onToggleSidebar, onOpenSearch }: { sidebarOpen: boolean; onToggleSidebar: () => void; onOpenSearch: () => void }) {
  const { editMode } = useEditorStore()
  const file = useEditorStore(s => s.tabs.find(t => t.path === s.activeTab))
  const vaultOpen = useVaultStore(s => s.isOpen)
  const vaultPath = useVaultStore(s => s.vaultPath)
  const [onboardingDone, setOnboardingDone] = useState(() => isOnboardingDone())

  useEffect(() => { clearEditorCache() }, [vaultPath])

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
          <TabBar onAiToggle={() => {}} sidebarOpen={sidebarOpen} onToggleSidebar={onToggleSidebar} onOpenSearch={onOpenSearch} />
          <OnboardingGuide onDismiss={() => setOnboardingDone(true)} />
        </div>
      )
    }

    if (!vaultOpen) return <WelcomeScreen />

    return (
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <TabBar onAiToggle={() => {}} sidebarOpen={sidebarOpen} onToggleSidebar={onToggleSidebar} onOpenSearch={onOpenSearch} />
        <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm italic">Select a file from the sidebar</div>
      </div>
    )
  }

  const kind = editorFileKind(file.path)

  /** Shared scroll container — all modes use the same container. */
  let inner: ReactNode
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
    inner = (
      <Suspense fallback={<div className="h-full flex items-center justify-center text-zinc-500 text-sm italic">Loading editor...</div>}>
        <WysiwygEditorHost
          key={file.path}
          vaultPath={vaultPath}
          filePath={file.path}
          markdown={(file.editedContent ?? file.content).replace(file.frontmatter, '')}
          onSync={md => useEditorStore.getState().setEditedContent(file.path, md)}
        />
      </Suspense>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      <TabBar onAiToggle={openXlAiMenu} sidebarOpen={sidebarOpen} onToggleSidebar={onToggleSidebar} onOpenSearch={onOpenSearch} />
      <div className="flex-1 flex flex-col min-h-0 relative">
        <div className="flex-1 min-h-0 overflow-y-auto pt-12 sm:px-16 px-8 pb-8">
          {inner}
        </div>
      </div>
    </div>
  )
}