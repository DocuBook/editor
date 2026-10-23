// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Editor from '../../../frontend/components/Editor'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  openFile: vi.fn(),
  vaultOpen: true,
}))

vi.mock('../../../frontend/lib/ipc', () => ({ invoke: mocks.invoke, isTauri: false, isMacTauri: false }))
vi.mock('../../../frontend/stores/editor', () => ({
  useEditorStore: Object.assign((selector: ((state: unknown) => unknown) | undefined) => selector ? selector({ editMode: 'editor', tabs: [], activeTab: null }) : ({ editMode: 'editor', tabs: [], activeTab: null }), { getState: () => ({ openFile: mocks.openFile }) }),
}))
vi.mock('../../../frontend/stores/vault', () => ({
  useVaultStore: (selector: (state: unknown) => unknown) => selector({ isOpen: mocks.vaultOpen, vaultPath: '/vault' }),
}))
vi.mock('../../../frontend/hooks/useKeyboard', () => ({ useKeyboard: () => {} }))
vi.mock('../../../frontend/utils/onboarding', () => ({ isOnboardingDone: () => true, markOnboardingDone: () => {} }))
vi.mock('../../../frontend/components/OnboardingGuide', () => ({ default: () => null }))
vi.mock('../../../frontend/components/editor/WelcomeScreen', () => ({ WelcomeScreen: () => null }))
vi.mock('../../../frontend/components/editor/TabBar', () => ({ TabBar: () => null }))
vi.mock('../../../frontend/components/editor/previews', () => ({ ImagePreview: () => null, PlainTextViewer: () => null, MarkdownEditor: () => null }))
vi.mock('../../../frontend/components/editor/DiffViewer', () => ({ DiffViewer: () => null }))
vi.mock('../../../frontend/stores/aiChat', () => ({ useAiChat: { getState: () => ({ focusInput: () => {} }) } }))
vi.mock('../../../frontend/utils/editorCache', () => ({ clearEditorCache: () => {} }))
vi.mock('../../../frontend/utils/mermaidRenderCache', () => ({ clearDiagramSVG: () => {} }))
vi.mock('../../../frontend/utils/fileKind', () => ({ editorFileKind: () => 'text' }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root
let container: HTMLDivElement
const render = (isDesktop: boolean) => act(() => root.render(
  <Editor sidebarOpen={false} isDesktop={isDesktop} sidebarToggleRef={{ current: null }} onToggleSidebar={() => {}} onOpenSearch={() => {}} />,
))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.vaultOpen = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('Editor empty state', () => {
  it('keeps the sidebar prompt on desktop', () => {
    render(true)
    expect(container.textContent).toContain('Select a file from the sidebar')
    expect(container.querySelector('button')).toBeNull()
  })

  it('shows New note on compact screens and opens an inline filename input', () => {
    render(false)
    const button = Array.from(container.querySelectorAll('button')).find(node => node.textContent?.includes('New note'))!
    expect(button).toBeDefined()
    act(() => button.click())
    expect(container.querySelector('input[aria-label="Filename"]')).not.toBeNull()
  })

  it('creates and opens the filename, adding .md when needed', async () => {
    mocks.invoke.mockResolvedValue('Draft.md')
    render(false)
    const button = Array.from(container.querySelectorAll('button')).find(node => node.textContent?.includes('New note'))!
    act(() => button.click())
    const input = container.querySelector('input[aria-label="Filename"]') as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Draft')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(mocks.invoke).toHaveBeenCalledWith('create_file', { path: 'Draft.md' })
    expect(mocks.openFile).toHaveBeenCalledWith('Draft.md', 'Draft.md')
  })
})
