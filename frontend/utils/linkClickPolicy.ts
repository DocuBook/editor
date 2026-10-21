/** What a click on a link INSIDE the editor may do.
 *
 *  BlockNote's default click handler calls `window.open(href)` for any href its
 *  `isAllowedUri` check accepts. That check permits every custom scheme
 *  (`myapp:`, `obsidian:`, …), so a note could hand an arbitrary protocol to the
 *  OS handler — while the link toolbar's "Open" button already refuses anything
 *  outside `http`/`https`/`mailto`/`tel`. Two entry points, two policies.
 *
 *  This is the editor's policy, installed through BlockNote's supported
 *  `links.onClick` option (which also disables its default open-on-click):
 *
 *  - vault-relative target → open the note in the app (the toolbar's behaviour),
 *  - external URL → open only through the allowlist in `externalLink`,
 *  - anything else → blocked, with the same message the toolbar shows.
 *
 *  Note content never gets to name a scheme we will hand to the OS. */
import { toast } from 'sonner'
import { useEditorStore } from '../stores/editor'
import { openExternalLink } from './externalLink'
import { safeExternalUrl } from './linkInput'
import { isVaultLinkUrl, resolveVaultLinkTarget } from './wikilink'

/** Handle a click on a link in the editor. Returns false when the click did not
 *  land on a link, so ProseMirror keeps its normal selection behaviour. */
export function handleEditorLinkClick(event: MouseEvent): boolean {
  const target = event.target as HTMLElement | null
  const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!anchor) return false

  // Always take the click: letting the browser follow the anchor is the
  // unchecked `window.open` path this handler exists to replace.
  event.preventDefault()

  const href = anchor.getAttribute('href') ?? ''
  if (!href) return true

  if (isVaultLinkUrl(href)) {
    const { activeTab, openFile } = useEditorStore.getState()
    const resolved = resolveVaultLinkTarget(href, activeTab ?? '')
    // Anchor-only links (`#section`) resolve to nothing; there is nothing to
    // open and the document itself has no anchor targets to scroll to.
    if (resolved) void openFile(resolved, resolved.split('/').pop() || resolved)
    return true
  }

  if (!safeExternalUrl(href)) {
    toast.error('Blocked link: unsupported or unsafe URL')
    return true
  }
  void openExternalLink(href)
  return true
}
