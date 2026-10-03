# Changelog

## v0.1.8 — 2026-10-03

### Patch Release

#### 🐛 Bug Fixes

- **Leaving the AI composer in one press or tap, and returning the caret** — Tapping or clicking outside the composer now dismisses it in a single interaction, and Escape does the same, both handing the caret back to the document. The outside-click listener previously ran only while the panel was expanded, so a collapsed composer with an open picker or a prompt awaiting input could not be left by clicking away, and it listened for `mousedown` — a touch or pen tap never fired it. It now tracks `pointerdown`, covering mouse, touch and pen alike, and is armed whenever the composer is expanded, a picker is open, or the turn is awaiting user input. Escape also calls `editor.focus()` on every platform: the AI extension restores focus only where focusing raises no soft keyboard, so on a phone the caret stayed stuck in the prompt box until the reader tapped the page — the reported “Escape twice to get back to the editor”. A composition guard was added too: a `compositionstart`/`compositionend` ref means the IME owns every key while it composes, including the cancel Escape some Android IMEs deliver with `isComposing` already false, so that key no longer tears the menu down mid-composition and wedges the keyboard. The commit timestamp lives in a ref rather than the effect-local variable, because the keydown effect re-mounts on every picker/menu change and used to forget the commit it was still guarding.
- **Per-request AI cancellation and live text streaming on web** — Web cancel state moved from a single in-flight slot to a map of `Set<AbortController>` keyed by request id, so concurrent turns — an AI panel edit next to a commit-message summary — each own their handle: a late Stop targets exactly one id, a turn that finishes no longer clears another turn's slot, duplicate ids are retained as a group so cancelling one aborts every matching turn, and id-less callers get an isolated `anon-N` slot, with a no-id `cancel_ai` aborting them all. On the transport side, `bufferText` is now driven by `useTools`: the tool-capable path still buffers and lets a meaningful tool op win, while the text-only fallback streams live again — restoring the reply as it types instead of flushing the whole thing once at the end.

## v0.1.7 — 2026-10-01

### Patch Release

#### 🚀 Features

- **Copy/paste in the vault tree context menu** — Right-clicking a tree row now offers Copy and Paste, backed by an in-app file clipboard kept deliberately separate from the editor's text clipboard and, like it, in-app only: the OS clipboard is never touched, so file paste behaves identically on desktop and web. Copy only records the row — nothing touches the filesystem until Paste, which runs through a new `copy_path` command. Paste targets the clicked row's folder (the row itself for a folder, its parent for a file — the same resolution New File uses) and resolves a name collision with a Finder-style suffix (`note.md` → `note copy.md` → `note copy 2.md`), comparing names case-insensitively so a case-sensitive Linux server never grows two rows a case-insensitive desktop reads as one; a leading dot stays with the stem, so `.env` copies to `.env copy`, not `.env.copy`. A folder copies its whole subtree (symlinks skipped, since following one can leave the vault or loop) and cannot be pasted into itself or a descendant. Because a path is relative, the clipboard is scoped to the vault it came from — Paste is disabled in another vault and when nothing has been copied, and the keyboard path skips the disabled row rather than landing on an action the pointer could not pick either.
- **Cut and move in the vault tree context menu** — The row menu gains Cut beside Copy: Paste then moves the row through a new `move_path` command instead of duplicating it, and a cut is consumed by the single paste that spends it. A move keeps its name or does nothing — a taken name is refused with the vault's own message rather than silently renamed (silent renaming would make cut-and-paste a different operation than the user asked for), a move within the same folder is a no-op, and a folder cannot land inside itself or a descendant. Because a move rewrites the row's path, a dirty editor buffer is flushed first so its next save cannot resurrect the file where it was moved from; open tabs are renamed and the create-here target is remapped to follow the row. Copy, cut and paste moved out of `Sidebar.tsx` into `useTreeActions`, so all four tree mutations now live in one hook.

#### 🐛 Bug Fixes

- **Sign out after a password change, and a revalidating app shell** — Changing the password revokes every session server-side, this one included, but the UI kept running on a cookie the server already rejected, so the sign-in screen only appeared at the next request's 401 or after a manual reload; the settings pane now ends the dead session itself, after a short pause that keeps the confirmation readable before Login replaces it. Alongside it, the web server sets an explicit cache policy on the static frontend: content-hashed files under `/assets/` are cached for a year as `immutable`, while the app shell (`/`, deep links, `index.html`) is revalidated on every load so a redeploy is picked up without a hard refresh. The immutable branch is keyed on the response, not the request path — a missing asset falls through the SPA fallback and answers with `index.html`, and pinning that shell to a year under the asset URL would recreate the stale-shell problem the policy exists to fix.
- **Stacked toasts, and one toast per trash batch** — Concurrent toasts now stack one above the other instead of overlapping until hovered (sonner's `expand`). Restoring or permanently deleting from the Trash reports its outcome and any refresh fallout in a single toast: previously the result was emitted before the refreshes were known, so a green “restored” could land beside a red “could not refresh” — two toasts that read as a contradiction — and a failed vault-view refresh could return before the success toast was ever shown. A batch blocked by a missing permission still goes to the permission dialog alone, with no toast repeating it.

## v0.1.6 — 2026-09-29

### Patch Release

#### 🐛 Bug Fixes

- **Language picker dropdown in the app theme** — The code block's language list is Mantine's Select popover, and its default portal target is `document.body`, outside the themed `.bn-container` that carries `data-mantine-color-scheme` — so the component CSS fell back to the library's light palette: a white dropdown inside a dark editor. It now portals through BlockNote's documented `usePortalElement()` (the `editor.portalElement` getter it replaces is undocumented and absent outside a mounted editor), and the dropdown, its rows and its empty state are painted from the app's own tokens in `index.css`, since a portalled popover is out of reach of the header's chrome rules. Hover stays scoped to unselected rows, so the pointer cannot paint over the row Enter would pick.
- **IME toolbar menus that opened behind the keyboard** — The mobile formatting toolbar sits at the bottom edge of the visual viewport, where the default `bottom` anchor leaves its dropdown in the keyboard's band: floating-ui measures zero room there and hands the skin a negative available height — an invalid `max-height` the browser drops — so the dropdown was neither clamped to the visible area nor flipped, and a tall one, the color menu, rendered entirely behind the keyboard where no tap could reach it. The row's menus now anchor to `top` on the IME toolbar, which gives the clamp a positive height to fit and scroll in; desktop has room below its bubble menu by construction and keeps upstream behavior. Both `Menu.Root` and `Popover.Root` also report their open state, so the editor caret is suppressed while a popup is up — the popup opens over the caret's own line — with only `.bn-editor` affected, so the link form and the AI prompt keep their carets, and the toolbar's unmount clears the counter so a popup torn down with the editor (tab switch) cannot leave the caret hidden.
- **Overflow panel buttons painted as pressed** — The formatting toolbar's “More formatting” panel is portalled through its popover, so its buttons land outside `.bn-toolbar`, where BlockNote scopes every toolbar-button rule: they fell back to Mantine's filled default, every button read as pressed, `data-selected` painted nothing (the current alignment was indistinguishable) and `data-disabled` kept the library's palette instead of the editor's. The toolbar's own tokens are re-scoped to the panel's class, leaving the other portalled popovers untouched.
- **AI composer under the IME toolbar** — The composer used to lift itself clear of BlockNote's mobile formatting strip by that strip's own height. It now collapses while the strip is up instead — the strip's gates are the keyboard being open and the editor holding focus, so while it is on screen the reader is editing the document — and it returns the moment the strip goes, draft intact. Closing the AI menu also stops restoring focus on a system whose focus raises the on-screen keyboard, which raised the strip under the composer mid-collapse; the caret, selection and scroll restore are unchanged, and desktop keeps the focus restore.
- **Placeholder flash on first open** — A created editor instance starts on BlockNote's default document, a single empty paragraph, and the markdown parse lived in a mount effect — after the first paint — so every first open of a note showed the placeholder (“Enter text or type '/' for commands”) until the note landed. The instance is now created with its markdown: `createBlockEditor` seeds through the same `loadMarkdownIntoEditor` path every later re-parse uses (code-mode edits, external changes), so the first paint is the note itself. A cache hit ignores the markdown on purpose — re-parsing there would throw away the undo history and in-flight edits the cache exists to keep.
- **System settings buttons** — “Update password” is now a submit button, disabled until all three fields are filled, wearing the page's primary style instead of a grey surface action; “Sign out” is `type="button"`, so it no longer submits the password form on its way to logging out, and is quiet until hovered — sign-out is destructive and should not out-shout the action it sits next to.

## v0.1.5 — 2026-09-28

### Patch Release

#### 🚀 Features

- **BlockNote 0.55.0** — The editor's block stack moves from 0.54.2 to 0.55.0 (`@blocknote/core`, `react`, `mantine`, `math-block`, `diagram-block`). Popovers now portal through the editor's themed portal element, which 0.55 takes as an explicit `portalElement`, so the formatting-toolbar and link/AI popovers keep the editor's styling and escape scroll-container clipping; their forms (link URL and title) commit through the form's native submit with `ScreenReaderOnlySubmit`, since an IME commits a candidate through submit without dispatching a key event — suggestion-list navigation stays on the key handler.
- **AI composer above the mobile formatting toolbar** — 0.55's mobile formatting toolbar is portalled into a body-level container pinned to the bottom of the visual viewport — the same strip above the on-screen keyboard the AI composer occupies on a phone. The composer now measures how far that strip's top edge reaches above its own positioning box and lifts itself by the same margin through a transitioned `margin-bottom`, following the strip as a taller keyboard or iOS panning the viewport moves it: it re-measures on `visualViewport` resize and scroll as well as on the toolbar appearing or disappearing, with the body mutation observer filtered to the toolbar node so per-keystroke ProseMirror DOM churn forces no layout. Without the strip the lift is 0, and a future BlockNote that renames the class degrades to overlap rather than mispositioning.
- **Block actions in the mobile formatting toolbar** — Where the hover-driven side menu does not exist — every shell below the 640px breakpoint, keyed to the same `isDesktop` query that drives `sideMenu` — the formatting toolbar now carries the side menu's block actions: a `+` that inserts a paragraph directly below the block at the text cursor and puts the caret on it (not the slash menu, which `/` already opens — a click and a keystroke for “add a block” were ambiguous), and Move up/down buttons around the public `moveBlocksUp`/`moveBlocksDown`, because dragging is HTML5 drag-and-drop and never fires from a touch pointer. The move passes no block id, so the selection travels with the block and the caret stays where it was; document edges are the commands' own no-op, and a click against a stale toolbar with no cursor to act on does nothing instead of throwing. At phone width the buttons live in the toolbar's overflow panel rather than its row, which cannot hold them without pushing its tail past the viewport edge.
- **Single mode toggle in the tab bar** — The Markdown/Blocks toggle group becomes one button whose icon shows the mode a click switches TO: the markdown icon while in WYSIWYG, the pencil-ruler while in source. The inline toolbar button and the compact Actions item share one `ModeSwitchIcon`, so the two controls can never show different icons; `toggleEditMode` wiring, the disabled state for non-`.md` files, and the tooltips are unchanged.

#### 🐛 Bug Fixes

- **Caret-reveal scrolls that hid the composer** — The composer's scroll-direction reveal now reacts only to a scroll a wheel or touch gesture produced (within 300 ms, ahead of the rAF-batched scroll event); a scroll the browser performs on its own — revealing the caret when the soft keyboard opens, advancing under an IME composition, restoring a `scrollIntoView` — merely re-syncs the tracked position. Previously that reveal read as the user scrolling down and hid the composer with the user's hands off the screen.
- **IME keys treated as composer keys** — The Enter that commits an IME candidate no longer sends the prompt, and while a composition is active the keys belong to the IME: the candidate arrows no longer walk the `@mention` picker, and Escape — or one landing within 250 ms of `compositionend`, since the window-capture listener runs ahead of the element handlers — cancels the candidate strip instead of dismissing the picker or the composer.
- **Keyboard raised when a note opens on a touch device** — Opening a note on a system whose focus raises an on-screen keyboard no longer claims focus: WYSIWYG and raw Markdown still restore the caret, selection, and scroll, but focus waits for the reader's tap, so a note opened on a phone no longer flashes the IME up only for the drawer's exit handoff to drop it again. The platform test reads Chromium's client hint, mobile UA tokens, and iPadOS's `MacIntel` plus touch points, and for Firefox on Android — a plain desktop UA with no hints — falls back to ARM Linux with a handset-sized short side; desktop systems and touchscreen laptops keep their focus restore, and the caret restore is unchanged on every platform.

## v0.1.4 — 2026-09-26

### Patch Release

#### 🚀 Features

- **Code block language picker** — The header's language label is now a searchable picker over every language Shiki can tokenize, loaded on demand the first time a dropdown opens so a document gains no eager weight. Picking a language rewrites only the fence's first token, so a `title="…"` or any other info the user typed survives in place. Search matches fence tokens as well as display names (`js`, `ts`, `jsonc` — not just “JavaScript”, “TypeScript”, “JSON with Comments”), and the control renders the fence token as typed, so a raw Markdown → WYSIWYG switch mounts every code block without waiting on an async import. The list stays inside the app window instead of running past it, a long language name ellipsizes instead of widening the block, and the tinted frame keeps the same 12px vertical rhythm as its neighbours.
- **Writing phase from the provider's first delta** — rust-ai emits `ai:generating` on the first non-empty delta — prose or tool-call arguments — and the AI menu leaves “thinking” as soon as the provider starts writing. In tool mode the completed call only lands at end of stream, so the status previously sat in “thinking” for the whole write and only moved once the client-side reveal began.
- **New File and New Folder in the tree context menu** — Right-clicking a vault row now offers New File, New Folder, Rename, and Delete. A new entry lands in the clicked row's folder — the folder itself for a folder row, the parent for a file — and a collapsed target is expanded first so the reload reveals the new child in place instead of inside a closed folder. The menu owns its dismissal, closing before handing an action to the caller so a row cannot leave a stale menu behind, and its keyboard controls: focus lands on the menu rather than its first row, arrows walk the rows and wrap at both ends, Home/End jump, and Escape dismisses.

#### 🐛 Bug Fixes

- **Half-parsed AI stream frames** — The hand-rolled SSE parser split the provider stream on newlines and flushed whatever was left in its byte buffer when the connection ended, so a connection that died mid-frame handed half a JSON payload on: if that half happened to parse, it was emitted as a real token or tool call. Framing now comes from `eventsource-stream`, the parser behind async-openai — multi-line `data:` fields are joined with LF, `data:value` without the optional space is accepted, CR-only line endings and a leading BOM are handled, and an event whose terminating blank line never arrives is dropped at EOF instead of parsed. The 8 MB guard sits on the raw byte stream, before the parser allocates anything, so a provider that never terminates an event cannot grow the buffer without bound; tripping it stays tripped and is reported as `response_too_large` rather than flattened into a generic transport failure. Cancel is checked before the first read, so Stop no longer waits for a chunk. The 30 s first-event timeout, `AI_MAX_SECONDS`, per-request event tagging, tool-call batching, and `process_sse_data` are unchanged. New dependencies: `eventsource-stream` 0.2.3 in both crates, plus `bytes` and `futures-util`.
- **Text-mode replies that were not content** — The text-only path has no schema to lean on, so a reply on its own could not say whether it was content or commentary *about* content — an answer, an apology, or an echo of the prompt was previously written into the document, replacing the selection or appending prose after the cursor. The text-mode prompt now asks for the payload inside `<content>…</content>`, and the transport writes only a delimited, non-empty payload; anything else reports “no document changes” instead. Casing and spacing variants of the tags still resolve, preamble and trailing notes are tolerated because the tags bound the payload, and the last closing tag wins so content that itself contains the literal tag is not truncated. When a request needs no document change at all — “fix spelling” on clean text — the model now answers without a content block instead of failing the turn.
- **Code blocks the AI is still writing** — While a fence is still streaming (` ```py ` → ` ```pyth ` …) Shiki is no longer asked for the half-typed language, which would fetch the wrong grammar or record an unknown one as unsupported, and cache an empty decoration set for the block. Once writing ends, the blocks the pause skipped parse again with the language they actually ended up with, and again whenever the language changes.
- **Drawer overlays on a phone** — Full-screen dialogs and the pointer-anchored context menu opened inside the mobile sidebar were centred and clipped by the drawer: its slide transition leaves an inline `transform` on the drawer content, which makes that element the containing block for `position: fixed` descendants. Both are now hosted on `document.body` through `OverlayPortal`, which keeps them above the drawer and carries its own focus trap so keyboard focus cannot fall back into the drawer behind the overlay or leave the menu unreachable. The drawer is also sized at 70% of the viewport instead of a fixed 224px, which was truncating every folder name, and the settings-permission dialog's opening control regains initial focus ahead of “Not now”.

#### 🔄 Refactor

- Tree mutations (`create`, `rename`, `delete`) and the transient state of their inline inputs moved out of `Sidebar.tsx` into `useTreeActions`, with the row menu in `SidebarContextMenu` and the viewport host in `OverlayPortal`. Any surface can now reach a tree action without owning its flow, and the sidebar stays a render. The rename input is keyed by path, so starting a rename on another row remounts it instead of inheriting the previous row's text. New coverage pins the menu (unit and integration), the code block header's DOM contract, the language catalogue, Shiki's refresh after an AI write, and the delimited-content rules.

## v0.1.3 — 2026-09-24

### Patch Release

#### 🐛 Bug Fixes

- **Request-scoped AI streams** — Every AI request now carries its own id, and both transports tag each event with the request that produced it. Stop, retry, and a superseded attempt can only affect the turn they belong to, so a commit-message generation running next to an AI panel turn no longer interleaves their tokens or cancels the wrong stream.
- **Prose fallback in tool mode** — A tool-capable provider that answers with prose instead of calling a tool is now re-asked once with the text-only prompt rather than failing the turn. The prose itself is never converted into a document edit, so the block ids from the tool prompt cannot leak into the text.
- **Retry budget** — Manual Retry is capped per turn and disabled once the budget is spent, and a stale Retry click against a closed or aborted session is a no-op instead of an unhandled rejection.
- **Composer model pick** — A model chosen in the composer now survives the settings hydration that can still land after boot, and the picker keeps the active model visible with a highlighted row, a check mark, and a scroll into view over a long model list.
- **Empty documents** — A document holding a single empty paragraph now counts as empty instead of only a document with zero blocks, so prompts and placeholders take the empty path. Prompt cursor context also resolves from the AI menu anchor rather than the live cursor, which goes stale once the composer takes focus and the editor is locked.
- **Git status without a timer** — Replaced the 3-second git-status poller with event-driven refreshes on git actions, vault open/close, and window focus. Vaults that are not repositories no longer fire a request every three seconds, and a failed refresh no longer leaves the store permanently empty.
- **Custom AI provider** — The server's saved-provider list keeps a custom OpenAI-compatible endpoint instead of filtering it out, so saving one no longer reports an empty provider list and disables the composer on the next browser or redeploy.
- **Mobile shell viewport** — The app shell is sized against the visible viewport (`dvh`, with the `100vh` fallback for Safari 15 and chrome105), and the soft keyboard resizes the layout viewport on Chromium, so the tab bar and the composer no longer scroll apart when the composer is focused on a phone. The document also reserves room for the composer at its full height at every width.

#### 🔄 Refactor

- Unit tests moved from `test/unit` to `test/__fixtures__`, with the shared React-settle helpers extracted into one harness, and the Docker build no longer copies the test directory.

#### 🔧 CI

- Added the `pullfrog.yml` workflow with dry-mode prompts for review, plan, build, and address-reviews.
- The browser E2E matrix no longer waits on the manual build-approval gate — it is a required PR check.
- E2E suites are discovered from `test/*.mjs` instead of a hardcoded list, a failing suite writes a per-assertion frame trail as an artifacts GIF, and a new mobile-shell suite pins the viewport contract as live geometry plus shipped artifacts.
- Retired the stale one-off E2E scripts (`trash`, `theme`, `overlay-surface`, `raw-markdown-highlight`, formatting toolbar, cursor table) and the `test:e2e:*` aliases that pointed at them.

## v0.1.2 — 2026-09-23

### Patch Release

#### 🚀 Features

- **Scroll-aware AI composer** — The floating AI composer now hides while scrolling down and fades back in when scrolling up, without covering content, and without clashing with the mobile sidebar drawer below 640px.

#### 🐛 Bug Fixes

- **AI settings across browsers** — Hydrating AI settings now waits for a logged-in session and retries with bounded backoff, so a fresh browser (or one that logged in after the server was briefly unreachable) no longer shows a disabled AI composer after the config was saved elsewhere.
- **Desktop AI composer padding** — Restored desktop padding so the composer does not overlap the last lines of the document.

## v0.1.1 — 2026-09-22

### Patch Release

#### 🚀 Features

- **AI settings sync** — Persisted the selected provider, model, configured endpoints, API-key state, and tool-call probes in the backend so AI settings survive browser changes and reloads.

#### 🐛 Bug Fixes

- **Mobile editor** — Kept the mobile chrome sticky so editor controls remain available while scrolling.
- **Sync conflicts** — Removed the misleading “Keep both” resolution option.

## v0.1.0 — 2026-09-21

### First Stable Release

DocuBook's first stable release. The early-access series (`0.1.0-next`) is now
promoted to stable: the API and configuration formats are considered settled,
and the desktop and web builds share one frozen command surface.

#### 🚀 Features

- **Offline sync** — Edits made without a connection are queued durably and reconciled on reconnect through a content-version guard, so a stale write can no longer silently clobber newer content.
- **AI selection and tool-call probes** — The selected model and tool-call capability are probed once and persisted across browsers, so the AI panel no longer re-discovers them per session.

#### 🐛 Bug Fixes

- **Editors** — Restored tabs after reload, kept the shell viewport-bound so the AI chat stays on screen, and aligned the raw caret with its WYSIWYG block across mode switches.
- **Safari compatibility** — Restored Safari 15 rendering on macOS 12.
- **Mentions** — Dropped the recursive tagline from mention folder rows.
- **Vault** — Added an opening state while a vault loads and closed the gaps in the vault opening overlay.
- **AI** — Retried the original prompt when the first attempt fails.
- **Chrome** — Fixed settings dropdowns misplaced by the dialog `backdrop-filter`.
- **Docker** — Scoped the `/data` ownership repair to the mount type.
- **CI** — Kept the Docker smoke test green on non-root runners.

#### 🔄 Refactor

- Removed the unused `.tip` tooltip system.

#### 🔧 CI

- Silenced unactionable build warnings and corrected the stale polyfill note.

#### 🔄 Version / Hygiene

- Dependency bumps: `trash` 5.2.9, `esbuild` 0.28.2, `@tauri-apps/plugin-opener` 2.5.5, `oxlint` 1.83.0, `lint-staged` 17.5.1, Rust 1.97-alpine.
- Fixed the Coolify mount table and documented the stale container issue.
- Updated the README description.

---

## v0.1.0-next — 2026-09-18

### Early Access Release for testing

First public build, published for early access testing. Everything listed below is already present and usable, but features, APIs, and configuration formats are still **unstable** — expect breaking changes before a stable release.

#### 🚀 Features

- **Local vaults** — Open, create, or clone vaults as plain folders of Markdown files, with no proprietary format. Other text formats can be viewed; `.md` and `.mdx` use the WYSIWYG editor.
- **WYSIWYG block editing** — Headings, lists, quotes, code, math, and Mermaid diagram blocks, plus inline formatting. Open the block menu with `/`, and switch to raw Markdown mode to edit the source directly.
- **Reviewable AI** — Write, improve, summarize, translate, and fix text from an in-editor AI menu and a floating AI chat. Every suggestion streams in and can be accepted or rejected before it reaches the document.
- **Provider choice** — Built-in AI providers plus custom OpenAI-compatible endpoints, configured in **Settings → AI**, with keys stored backend-side.
- **Git publishing** — Configure identity and a remote, then stage, commit, push, and see the active branch without leaving the editor.
- **Fast navigation** — File search, expandable folders, backlinks, wikilinks, and keep-alive editor tabs that survive folder renames.
- **Desktop and web** — macOS desktop builds for Apple Silicon and Intel, and a Docker image for web with a required admin account on first run plus a `/api/health` check.
- **Theming** — Named themes with light- and dark-mode polish across the editor and app chrome.
- **Reliable autosave** — Editor changes are persisted at the app layer instead of depending on tab transitions.

---

## Versioning

This project follows **manual versioning** (not semver). Versions are:

- `0.1.0` — First stable release. API and configuration formats are settled.
- `0.x.0-next` — Later testing builds, when a change needs field validation before it lands in a stable release. Features, API, and configuration format may change.
- `0.x.y-beta` — Beta releases. API stabilization in progress.
- `1.x.0` — Future stable releases.

See [README.md](README.md) for documentation and setup guide.
