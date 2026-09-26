# Changelog

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
