import { create } from 'zustand'

/** Anchor ids for the settings sections. Stable, lower-case strings shared by
 *  the sidebar tree (which selects one) and the editor-container pane (which
 *  renders every section with a matching `id`), so a nav click can scroll the
 *  pane to its section without prop-drilling a callback through both surfaces. */
export type SettingsSectionId = 'general-themes' | 'general-account' | 'git-identity' | 'git-remotes' | 'ai-provider' | 'ai-mcp-server'

/** The top-level MENU a section belongs to. A menu owns one PAGE in the sidebar
 *  and expands to that page's section rows. */
export type SettingsGroupId = 'general' | 'git' | 'ai'

/** The PAGE a section lives on: General, Git, or AI. Every section of a menu's
 *  page is an anchored `#id` target inside it, so the AI page holds both the
 *  Provider and MCP Server sections and the pane scrolls between them. */
export type SettingsPageId = 'general' | 'git' | 'ai'

/** Which page a section lives on. The nav click opens this page and the pane
 *  scrolls to the section's `#id` inside it. */
export function pageOf(id: SettingsSectionId): SettingsPageId {
  if (id.startsWith('general-')) return 'general'
  if (id.startsWith('git-')) return 'git'
  return 'ai'
}

/** The top-level MENU a section belongs to — the sidebar group that holds its
 *  page row (so the sidebar can mark the owning menu active). */
export function groupOf(id: SettingsSectionId): SettingsGroupId {
  if (id.startsWith('general-')) return 'general'
  if (id.startsWith('git-')) return 'git'
  return 'ai'
}

/** The first section of each page, used when a menu row is clicked (as opposed to
 *  one of its section anchors): the page opens at its first section. General is
 *  FIRST: opening Settings (no explicit section) lands here. */
export const PAGE_FIRST_SECTION: Record<SettingsPageId, SettingsSectionId> = {
  general: 'general-themes',
  git: 'git-identity',
  ai: 'ai-provider',
}

interface SettingsState {
  /** Whether the settings surface is showing in the editor container. Replaces
   *  the old modal's local `open` boolean: the sidebar, ⌘, and the profile menu
   *  all drive this ONE flag, so any entry point opens the same surface. */
  open: boolean
  /** Section the sidebar last anchored to. The pane scrolls to it; a plain
   *  "open settings" leaves the current one so ⌘, returns where you left off. */
  section: SettingsSectionId
  openSettings: (section?: SettingsSectionId) => void
  closeSettings: () => void
  setSection: (section: SettingsSectionId) => void
}

/** Settings navigation state. Kept out of App's local state so the sidebar can
 *  open and navigate the surface with a single action (no callback plumbing),
 *  and so both sidebar instances (desktop + mobile drawer) share one source. */
export const useSettings = create<SettingsState>()((set) => ({
  open: false,
  section: 'general-themes',
  openSettings: (section) => set(state => ({ open: true, section: section ?? state.section })),
  closeSettings: () => set({ open: false }),
  setSection: (section) => set({ section }),
}))
