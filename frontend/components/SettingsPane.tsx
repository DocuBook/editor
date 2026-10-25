import { useEffect, useRef } from 'react'
import { isTauri } from '../lib/ipc'
import { useAiSettings, CUSTOM_PROVIDER_ID } from '../stores/aiSettings'
import { useSettings, pageOf, groupOf, PAGE_FIRST_SECTION, type SettingsPageId } from '../stores/settings'
import { SETTINGS_GROUPS } from '../data/settingsTree'
import GitSettings from './GitSettings'
import SystemSettings from './SystemSettings'
import AppearanceSettings from './AppearanceSettings'
import SettingsSection from './settings/SettingsSection'
import ProviderForm from './settings/ProviderForm'
import WebToolsSettings from './settings/WebToolsSettings'

/** The settings surface — the ONE implementation of the settings UI, rendered in
 *  the editor container and navigated by the sidebar tree. Every entry point
 *  (profile menu, ⌘,) flips the store's `open` flag; this component reads the
 *  store's selected section and renders that section's MENU page. */
export default function SettingsPane() {
  /** Section the sidebar last anchored to. Its MENU owns the page rendered here;
   *  the section itself is the `#id` scrolled into view inside that page. */
  const storeSection = useSettings(s => s.section)
  /** Bumped by the store on every navigation request, even when `section` is
   *  unchanged. The scroll effect keys on it so a repeated click on the SAME
   *  anchor re-centers the pane — the section id is value-equal on a repeat
   *  click, so keying on it alone would skip the scroll for a user who scrolled
   *  deep into a section taller than the window. */
  const navNonce = useSettings(s => s.navNonce)
  /** Pane: scroll the selected section into view inside the open page. */
  const paneScrollRef = useRef<HTMLDivElement>(null)
  /** The pane's inner column — its bottom padding is sized so the LAST section
   *  can still reach the top (see the effect below). */
  const paneContentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    /** `scrollIntoView({block:'start'})` clamps at the scroll limit, so a section
     *  with too little content below it — the LAST section, shorter than the
     *  pane — can never reach the top; it hovers near the bottom with the
     *  previous, often long, section filling the view. Reserve exactly the
     *  trailing space the last section needs to top-align: 72px is the pane's
     *  bottom padding (py-10 = 40px) plus the section's scroll-margin
     *  (scroll-mt-8 = 32px). Sizing on the LAST section covers every earlier one. */
    const pane = paneScrollRef.current
    const content = paneContentRef.current
    if (pane && content) {
      const sections = content.querySelectorAll<HTMLElement>('[data-settings-section]')
      const lastSection = sections[sections.length - 1]
      const pad = lastSection ? Math.max(0, pane.clientHeight - lastSection.offsetHeight - 72) : 0
      content.style.paddingBottom = pad ? `${pad}px` : ''
    }
    // Ids are simple and unique app-wide, so a plain lookup beats a selector
    // (and avoids depending on CSS.escape, which jsdom does not always provide).
    const target = document.getElementById(storeSection)
    // jsdom has no layout; guard so tests never depend on scrollIntoView.
    target?.scrollIntoView?.({ block: 'start' })
  }, [storeSection, navNonce])
  /** Selecting the Provider section seeds the CUSTOM provider when nothing is
   *  selected yet, so the section's first form has an endpoint to edit. It never
   *  overrides a provider the user already chose. */
  useEffect(() => {
    if (storeSection === 'ai-provider' && !useAiSettings.getState().provider) useAiSettings.getState().setProvider(CUSTOM_PROVIDER_ID)
  }, [storeSection])

  /** The page rendered here, and the sidebar MENU that owns it. */
  const page = pageOf(storeSection)
  const activeGroup = groupOf(storeSection)
  /** The FIRST section of each page is the `h2` PAGE TITLE, not a section body:
   *  its anchor id lives on the heading so the sidebar row scrolls to the title
   *  itself. The remaining sections keep their own `<section id>`. Looking the id
   *  up in the tree (rather than hardcoding a map) keeps the ids — or a page that
   *  gains/loses a first section — in one place: the nav data. */
  const firstSectionId = PAGE_FIRST_SECTION[page]
  /** True when the first section IS the title (always, in the shipped tree). The
   *  section below it then keeps its divider (the title replaced the section that
   *  would otherwise sit on top of it); GitSettings reads this the same way. */
  const titleIsFirstSection = SETTINGS_GROUPS.find(group => group.id === activeGroup)?.items[0]?.id === firstSectionId

  /** The page title IS its menu name, so the pane and the sidebar row that opened
   *  it always read the same. One heading per page. */
  const pageTitle: Record<SettingsPageId, string> = {
    general: 'General',
    git: 'Git',
    ai: 'AI',
  }

  /** Pages keyed by PAGE (not by section): each page owns one view, and its
   *  sections are the anchored anchors inside it. Clicking a section opens its
   *  page and scrolls to that section's id. Sections own their own spacing and
   *  divider (SettingsSection), so the page adds none of its own. */
  const pages: Record<SettingsPageId, React.ReactNode> = {
    /** General is the first page: themes, plus Account on Docker only (the
     *  desktop app has no account or runtime config, so the section is absent
     *  there — matching the sidebar, which hides that row on desktop). */
    general: (
      <>
        {/* No id: the page title above already IS this section's anchor, and a
            duplicate id would make the first sidebar row a dead link twice over. */}
        <SettingsSection title="Themes" first><AppearanceSettings /></SettingsSection>
        {!isTauri && <SettingsSection id="general-account" title="Account"><SystemSettings /></SettingsSection>}
      </>
    ),
    /** Git identity + remotes are the two sections on the ONE Git page; each
     *  carries its own id (rendered inside GitSettings) so both rows have a real
     *  target. */
    git: <GitSettings titleIsFirstSection={titleIsFirstSection} />,
    /** The AI page has TWO sections: Provider (all three provider forms, ONE per
     *  provider, each pinned to its provider) and Web Tools. The sidebar lists
     *  these two rows; the forms inside Provider are content, not anchors. */
    ai: (
      <>
        {/* No id: the page title above IS the Provider anchor (see General). */}
        <SettingsSection title="Provider" first>
          {/* No `space-y-*` here: each form carries its own top margin + divider via
              FORM_DIVIDER_CLASS, and a spacing utility would add a second gap and
              defeat the `first` opt-out that keeps the top card divider-free. */}
          <ProviderForm provider={CUSTOM_PROVIDER_ID} first />
          <ProviderForm provider="opencode-go" />
          <ProviderForm provider="deepseek" />
        </SettingsSection>
        <SettingsSection id="ai-web-tools" title="Web Tools"><WebToolsSettings /></SettingsSection>
      </>
    ),
  }

  /** Editor-container surface: the ONE page the selected section's page owns.
   *  No overlay — the workspace stays interactive, and no other menu is stacked
   *  behind it. */
  return (
    <div data-testid="settings-container" className="flex-1 flex flex-col min-w-0 min-h-0">
      {/* `relative` keeps the pane a containing block: an absolutely-positioned
          descendant (e.g. Mantine's `.sr-only` label for its password inputs)
          would otherwise resolve against the initial containing block instead of
          this scroll box, escaping its `overflow-y: auto` clip and landing at the
          bottom of the scrolled content — which hands the DOCUMENT scroll range,
          so `scrollIntoView` (below) or the IME/caret reveal scrolls the shell and
          drags the 48px mobile top bar off the top of the screen. Making this box
          the containing block contains+clips those descendants instead. */}
      <div ref={paneScrollRef} className="settings-pane-scroll relative flex-1 min-h-0 overflow-y-auto px-6 py-10">
        <div ref={paneContentRef} className="mx-auto w-full max-w-2xl">
          {/* The first section's anchor id rides the page title, so its sidebar
              row scrolls to the heading. One id, on the heading, per page. */}
          <h2 data-testid="settings-page-heading" id={titleIsFirstSection ? firstSectionId : undefined} className="text-base font-semibold text-foreground mb-6 scroll-mt-8">{pageTitle[page]}</h2>
          {pages[page]}
        </div>
      </div>
    </div>
  )
}
