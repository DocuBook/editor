import type { ReactNode } from 'react'
import type { SettingsSectionId } from '../../stores/settings'

/** Separator between two sections on the SAME page: generous space above, a
 *  hairline divider, generous space below. The FIRST section of a page passes
 *  `first` to drop both — there is nothing above it to separate from. Relying on
 *  `first:` (the `:first-child` variant) instead would NOT work here: the page
 *  title renders before the sections, so no section is ever `:first-child`. */
export const SECTION_CLASS =
  'scroll-mt-8 mt-8 border-t border-border-subtle pt-8'

/** A section at the TOP of its page: no divider, no top margin — the page title
 *  is what sits above it. */
export const SECTION_FIRST_CLASS = 'scroll-mt-8'

/** Separator between two CARDS inside ONE section (e.g. the three provider forms
 *  on the AI page). Same rhythm as `SECTION_CLASS`, but for content that carries
 *  no sidebar anchor. The first card passes `first` to drop its divider, since it
 *  is the topmost thing under the section heading. Apply it to items in a
 *  container WITHOUT `space-y-*` — that utility would add a second gap. */
export const FORM_DIVIDER_CLASS = SECTION_CLASS

/** The card treatment for the FIRST card inside a section. */
export const FORM_DIVIDER_FIRST_CLASS = SECTION_FIRST_CLASS

/** One section inside its menu's page. The sidebar row links to the section's
 *  `id`, so the pane can scroll straight to it; every section carries the same
 *  divider + spacing treatment, so the rhythm is identical no matter which menu
 *  owns the page. Pass `first` for the section at the top of a page (no divider).
 *
 *  Omit BOTH `id` and `title` for the first section of a page: its anchor id
 *  rides the page heading (the pane owns the `#id`), and the heading IS its
 *  title, so the section renders only the content. */
export default function SettingsSection({ id, title, first, children }: { id?: SettingsSectionId; title?: string; first?: boolean; children?: ReactNode }) {
  return (
    <section id={id} data-settings-section className={first ? SECTION_FIRST_CLASS : SECTION_CLASS}>
      {title && <h3 className="text-xs font-semibold text-foreground uppercase tracking-wide mb-2">{title}</h3>}
      {children}
    </section>
  )
}
