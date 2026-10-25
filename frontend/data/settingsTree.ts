import { SlidersHorizontal, GitBranch, Sparkles } from 'lucide-react'
import type { SettingsSectionId, SettingsGroupId, SettingsPageId } from '../stores/settings'

/** One leaf: a section that anchors into its page. Selecting it opens the page
 *  (if closed) and scrolls the pane to the section with this id. */
export interface NavItem {
  id: SettingsSectionId
  label: string
  /** Rendered only on the Docker/web server build. The desktop app has no
   *  account or runtime config, so the Account row would be a dead link there. */
  dockerOnly?: boolean
}

/** A top-level MENU, mirroring the vault tree's expand/collapse rows. A menu owns
 *  ONE page (`page`), whose sections are its `items`: the rows it expands to. A
 *  row opens that page and scrolls to its section — the AI menu, for example,
 *  lists the Provider and MCP Server sections of the ONE AI page. */
export interface NavGroup {
  id: SettingsGroupId
  label: string
  Icon: typeof SlidersHorizontal
  /** The page the menu's sections render on (General, Git, AI). */
  page: SettingsPageId
  /** The menu's sections, in the order they render down the page. */
  items: NavItem[]
}

/** The settings tree shown in the sidebar. Menus default to expanded so the
 *  page — and its section anchors — are reachable in one click; the collapses
 *  are navigation aids, not gates. Data (not markup) so adding a page touches
 *  this list alone and the component stays a plain map. */
export const SETTINGS_GROUPS: NavGroup[] = [
  {
    id: 'general',
    label: 'General',
    Icon: SlidersHorizontal,
    page: 'general',
    items: [
      { id: 'general-themes', label: 'Themes' },
      { id: 'general-account', label: 'Account', dockerOnly: true },
    ],
  },
  {
    id: 'git',
    label: 'Git',
    Icon: GitBranch,
    page: 'git',
    items: [
      { id: 'git-identity', label: 'Identity' },
      { id: 'git-remotes', label: 'Remotes' },
    ],
  },
  {
    id: 'ai',
    label: 'AI',
    Icon: Sparkles,
    page: 'ai',
    /** The ONE AI page has three sections, top to bottom: Provider (whose own
     *  content is the three provider forms), Web Tools and MCP Server. */
    items: [
      { id: 'ai-provider', label: 'Provider' },
      { id: 'ai-web-tools', label: 'Web Tools' },
      { id: 'ai-mcp-server', label: 'MCP Server' },
    ],
  },
]
