import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useSettings, groupOf, PAGE_FIRST_SECTION } from '../../stores/settings'
import { SETTINGS_GROUPS } from '../../data/settingsTree'
import type { NavGroup, NavItem } from '../../data/settingsTree'
import { isTauri } from '../../lib/ipc'

/** Match the vault tree's indentation for nested rows. */
const DEPTH_1 = 'depth-1'

/** Settings navigation, rendered in the sidebar in place of the vault tree while
 *  the settings store's `open` flag is on (set by the profile menu / ⌘,).
 *
 *  A MENU row does BOTH things at once: it collapses/expands its list (the vault
 *  tree's affordance) and opens its OWN page in the editor container. Its list
 *  holds the page's section anchors: clicking one opens that page and scrolls to
 *  the section, so every menu (General, Git, AI) navigates the same way.
 *
 *  Only ONE menu is expanded at a time, and the expanded menu IS the store's
 *  active menu: opening a page expands its menu and collapses the rest, so the
 *  sidebar always shows the current page's sections — never every page's anchors
 *  at once. `collapsedOverride` holds the ONE menu the user explicitly folded
 *  away (clicking the active menu hides its own list); it clears as soon as a
 *  different menu is opened, so it never shadows the next expansion. */
export default function SettingsNav() {
  const openSettings = useSettings(s => s.openSettings)
  const section = useSettings(s => s.section)
  const activeGroup = groupOf(section)
  /** The menu the user folded away — `null` means "follow the active menu". */
  const [collapsedGroup, setCollapsedGroup] = useState<string | null>(null)

  const visible = (items: NavItem[]) => items.filter(item => !item.dockerOnly || !isTauri)

  /** A section of the menu's page: opens the surface and scrolls to this `#id`. */
  const anchorRow = (item: NavItem) => {
    const active = section === item.id
    return (
      <a
        key={item.id}
        href={`#${item.id}`}
        data-testid={`settings-nav-section-${item.id}`}
        aria-current={active ? 'true' : undefined}
        onClick={(e) => { e.preventDefault(); openSettings(item.id) }}
        className={'flex items-center gap-2 py-1 pr-2 rounded cursor-pointer ' + DEPTH_1 + ' ' + (active ? 'bg-surface-active text-foreground' : 'text-foreground-secondary hover:bg-surface-active')}
      >
        <span className="truncate">{item.label}</span>
      </a>
    )
  }

  const groupRow = (group: NavGroup) => {
    const groupActive = activeGroup === group.id
    const isExpanded = groupActive && collapsedGroup !== group.id
    return (
      <div key={group.id}>
        <button
          type="button"
          /* One click opens the menu's page (expanding it, collapsing the others).
             Clicking the ALREADY-open menu folds its list away without leaving the
             page — the store keeps rendering that page in the editor container. */
          onClick={() => {
            if (groupActive) setCollapsedGroup(isExpanded ? group.id : null)
            else { setCollapsedGroup(null); openSettings(PAGE_FIRST_SECTION[group.page]) }
          }}
          aria-expanded={isExpanded}
          aria-current={groupActive ? 'true' : undefined}
          data-testid={`settings-nav-group-${group.id}`}
          className={'flex w-full items-center gap-2 py-1 pr-2 rounded hover:bg-surface-active cursor-pointer bg-transparent border-none text-left ' + (groupActive ? 'text-foreground' : 'text-foreground-subtle hover:text-foreground-secondary')}
        >
          <ChevronDown size={14} className={'shrink-0 transition-transform ' + (isExpanded ? '' : '-rotate-90')} />
          <group.Icon size={14} className="shrink-0" />
          <span className="truncate font-medium">{group.label}</span>
        </button>
        {isExpanded && visible(group.items).map(anchorRow)}
      </div>
    )
  }

  return (
    <div className="flex-1 p-2 text-sm overflow-y-auto space-y-0.5" data-testid="settings-nav">
      {SETTINGS_GROUPS.map(groupRow)}
    </div>
  )
}
