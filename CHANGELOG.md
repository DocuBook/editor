# Changelog

## v0.1.0-beta.3 — 2026-08-06

### Named themes + project layout refactor

Theme system migrates to Tailwind v4 `@theme` tokens with two named themes (Midnight / Bright Surfaces), the desktop titlebar finally follows the app theme, and the repository layout is reorganized (frontend/ + server/ + flattened src-tauri/).

#### 🚀 Features

- **Named themes (Zed-style)** — Settings → Appearance: pick **Midnight** (dark, default) or **Bright Surfaces** (light). Palettes live in `@theme` tokens (`bg-background`, `text-foreground`, …); light mode corrects the hardcoded zinc text that was invisible on white
- **Titlebar follows the app theme** — Tauri window `theme: Dark` config + `window.setTheme()` runtime; fixed the ACL gap (`core:window:allow-set-theme`) that silently blocked theme switching; meta `theme-color` drives the web browser chrome
- **Show/hide password** — new `PasswordInput` on the web login and change-password forms (eye toggle, `type="button"`, aria-labeled)
- **E2E Playwright suites** — `theme-check` (12 assertions: dark/light/picker/persist) + `web-smoke` (4 assertions: health, setup wizard, logout, login against the real server)

#### 🔄 Refactor

- **Layout** — `src/` → `frontend/`, `src-tauri-server/` → `server/` (flattened, `[[bin]] path = main.rs`), `src-tauri/src/` flattened to crate root; all configs, CI, Dockerfile, docs updated; `server` reuses desktop modules via `#[path]`
- **Markdown module deduped** — `markdown.rs` shared by desktop + server via `#[path]` include (was copy-pasted twice); snapshot tests lock the HTML contract for both
- **Testing hardening** — 9 API integration tests (axum `tower::oneshot`: setup token gate, rate limits, session, path allowlist), store tests now exercise the real `useAiSettings` (was a copy), regression tests for setup-token + git-poll skip, `tsc`/clippy CI blockers fixed
- **Zinc → tokens** — hardcoded zinc text/hover colors migrated to theme tokens (light-theme visibility)

## v0.1.0-beta.2 — 2026-08-05

### Setup-token guard completed (UI + docs)

`DB_SETUP_TOKEN` now works end-to-end: the setup wizard asks for the token when the server requires it, and the token format is documented.

#### 🚀 Features

- **Setup wizard token field** — `setup_status` reports whether a token is required (`setupToken`); the wizard shows the "Setup token" input only then and submits it with `setup_admin`. Previously the wizard could never complete when `DB_SETUP_TOKEN` was set
- **Token format documented** — `DB_SETUP_TOKEN` is a **plain secret string (not a JWT)**, compared verbatim; `openssl rand -hex 32` example in `.env.example` / `docker-compose.yml`

#### 🔄 Version

- Bumped to `0.1.0-beta.2` across `package.json`, `src-tauri/Cargo.toml`, `src-tauri-server/Cargo.toml`, `src-tauri/tauri.conf.json`, lock files (package-lock was stale at alpha.6 — synced)

## v0.1.0-beta.1 — 2026-08-05

### Web (Docker) distribution + admin account

Same codebase now ships as a self-hosted web server (`docubook/editor` image): the React frontend served over HTTP, backed by the same Rust modules as the desktop app — no extra build steps, `docker pull` and run. Desktop distribution (DMG) is unchanged.

#### 🚀 Features

- **Web server (`src-tauri-server`)** — axum HTTP server reusing the desktop vault/wiki/git/search/agent modules via `#[path]` includes; single binary serving the built frontend + `/api/*`; SSE streaming for AI
- **Setup wizard on first run** — create the admin account (Argon2id, session cookie `HttpOnly`/`SameSite=Strict`, login rate-limited 5×/min). Headless provisioning via `DB_ADMIN_EMAIL`/`DB_ADMIN_PASSWORD` env; `DB_NO_AUTH=1` keeps open access (pre-web behavior)
- **Settings → System (web only)** — change password, sign out, toggle login requirement, session TTL. Precedence: env var > `/data/config.json` > default; env-sourced values shown locked ("from env")
- **Vault picker modal (web)** — replaces the browser `prompt()` with an in-app modal (list / open / create), same contract as the native folder dialog
- **Docker packaging** — multi-stage build (node → rust musl → alpine), non-root user, `/data` volume, `HEALTHCHECK` on `/api/health`, GHCR publish on tags (`ghcr.io/docubook/editor`); all server env vars documented in `.env.example`

#### 🛡️ Security

- **Setup-takeover guard** — optional `DB_SETUP_TOKEN` (required in the wizard when set) + rate-limited `setup_admin`; closes the pre-auth admin-claim race on public deployments (backward compatible: no env = previous behavior)
- **Server path allowlist** — vault paths must resolve inside `DATA_DIR`; closes arbitrary file read via the API (desktop unaffected — it still opens any local folder)
- **Security headers** — CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy` on static and API responses

#### ⚡ Performance

- **git_status: 1 subprocess instead of 2** — `--porcelain=v2 -b` mapped back to v1 output; desktop command now async (off the UI thread); ~38% cheaper per 3s poll
- **AI request timeouts** — 30s budget for response headers and first token; frontend watchdog aborts stalled streams after 60s; generic API calls time out after 30s
- **Smaller image** — `strip = "debuginfo"` release profile (symbols kept for `RUST_BACKTRACE`)

#### 🐛 Bug Fixes

- **Static assets gated by auth** — the middleware wrapped the whole router incl. the frontend, so after setup the app shell returned 401 and the UI never loaded; non-`/api` paths are now always public (data access stays gated)
- **SPA fallback returned 404** — `not_found_service` forces `404`; switched to `fallback()` so deep links serve `index.html` with 200
- **System tab on desktop showed endless loading** — web-only tab is now hidden in the Tauri app
- **Deadlock on first setup** — `setup_admin` re-locked the non-reentrant config mutex; lock released before issuing the session cookie
- **Healthcheck "connection refused" (dual-stack)** — the server bound IPv4-only (`0.0.0.0`), but `localhost` resolves to `::1` inside containers, so Coolify/Docker healthchecks probing `localhost` failed; now binds `[::]` (dual-stack, IPv4 fallback)

#### 🔧 CI

- **Docker image built on every PR** (push only on tags) with a `Report image size` step — Dockerfile breakage is caught before merge
- **Multi-platform image (`linux/amd64` + `linux/arm64`)** — QEMU emulation on the runner; README ARM claim (Raspberry Pi / Apple Silicon) now accurate

#### 🔄 Renames

- Desktop crate: `DocuBook` → `docubook-desktop`; web server crate: `docubook-server` (CI/Docker paths updated)

## v0.1.0-alpha.10 — 2026-08-05

### Only `.md` — extension standardization + onboarding

Editor, sidebar, and wiki now treat `.md` as the sole first-class extension. Every other file type is preview-only. The sidebar hides non-`.md` files, auto-appends `.md` on new-file creation, and strips the extension from the tree display. A one-time onboarding guide welcomes new users.

#### 🚀 Features

- **Onboarding guide** — four-step overview (create note, switch modes, AI, git) shown once per install when a vault opens. Survives force-quit and updates via `localStorage`; never re-appears after dismissal

#### 🐛 Bug Fixes

- **MarkdownEditor double scrollbar** — removed `min-h-full` from the source textarea; replaced with auto-resize so only the outer container scrolls
- **AI button flicker in code mode** — reverted auto-switch-to-Editor behavior; ✨ now disabled in code mode with tooltip "Switch to Editor for AI"

#### 💄 Polish

- **Sidebar `.md` standardization:**
  - Only `.md` files and directories appear in the tree (`.txt`, `.json`, `.mdx`, images, etc. are hidden from the sidebar)
  - New files auto-append `.md` when the user doesn't type an extension
  - Rename preserves `.md` when the old file had it and the user doesn't type a new extension
  - Tree display strips `.md` (tab titles and search results show the full filename)
- **Extension cleanup — removed `.markdown` / `.mdx` special handling:**
  - `fileKind` now returns only `'wysiwyg'` (`.md`) or `'preview'` (everything else)
  - `.mdx` and `.markdown` are now preview-only (previously: source-only and WYSIWYG respectively)
  - `EditMode` renamed to `'editor' | 'code'` (was `'wysiwyg' | 'markdown'`)
- **GraphView removed** — experimental feature deleted; backend `wiki_graph` command, GraphNode/Edge/Data structs, and all UI references cleaned up across 9 files
- **README:** updated keyboard shortcuts, install guide, and `.mdx` references to reflect current state

---

## v0.1.0-alpha.9 — 2026-08-05

### Fix arm64 launch — keep ad-hoc signature on Apple Silicon

v0.1.0-alpha.8 stripped the linker's ad-hoc signature on arm64 to match x86_64 (unsigned → "Open Anyway" parity). That broke arm64 launch entirely: Apple Silicon launchd **refuses to spawn an unsigned arm64 binary** (`RBSRequestErrorDomain Code=5` / `POSIX 163 Launch failed`). So the ad-hoc signature is now **kept** on aarch64 — the price is a different Gatekeeper dialog ("app is damaged" with no Open Anyway button), which is bypassed via `xattr -cr DocUBook.app` once after download. x86_64 stays stripped-unsigned ("developer cannot be verified" → right-click Open). The CI gates this: arm64 build fails if the binary is unsigned.

#### 🐛 Bug Fixes

- **Apple Silicon launch fails (POSIX 163)** — aarch64 CI no longer strips the ad-hoc signature (`codesign --remove-signature` limited to `if: amd64`). A new **Verify arm64 signature** step fails the build if the arm64 binary is unsigned — launchd requires the signature to spawn the process

#### 📚 Documentation

- **Install guide** — First launch section is now per-arch: `xattr -cr` for Apple Silicon, right-click Open for Intel. Troubleshooting line added for POSIX 163 on arm64

---

## v0.1.0-alpha.8 — 2026-08-04

### Unsigned DMG on Apple Silicon

The aarch64 (Apple Silicon) DMG previously shipped **ad-hoc signed** — macOS arm64 binaries are auto-signed by the linker (ld64) at link time. An ad-hoc-signed app + quarantine fails Gatekeeper with **"app is damaged and can't be opened"**, which has no Open Anyway bypass. The build now strips the ad-hoc signature before bundling, so both architectures ship fully unsigned — Gatekeeper shows *"developer cannot be verified"* with the **Open Anyway** option on first run. CI-only change; no app code changed.

#### 🐛 Bug Fixes

- **"App is damaged" on Apple Silicon** — CI workflow now splits `tauri build` (no bundle) → strip linker ad-hoc signature (`codesign --remove-signature`, fails loud per CI-1 if still signed) → `tauri bundle`. x86_64 links unsigned already and is unaffected — end state: both arches unsigned → Open Anyway available

---

## v0.1.0-alpha.7 — 2026-08-04

### Wiki link navigation

The link toolbar's **Open** action is now context-aware, with native/web parity (ADR D10): a link to a vault note opens the note inside the app; an external URL opens in the system browser on native and a new tab on web. All changes are **backward compatible** — no breaking API or config changes.

#### 🐛 Bug Fixes

- **External links did nothing on native** — `window.open` in WKWebView is a silent no-op (Tauri default `new_window_handler: None`, wry's WKUIDelegate returns nil). External links now open via the system opener on native (`tauri-plugin-opener` → macOS `open`), falling back to `window.open` on web

#### 🚀 Features

- **Wiki-aware link toolbar** — the link toolbar's Open button now checks the link target: a vault-relative link (`[notes](notes.md)`, no scheme) calls `openFile` and opens the note in the app; anything else opens externally. Edit/Remove keep BlockNote defaults

---

## v0.1.0-alpha.6 — 2026-08-03

### Security hardening & release readiness

Execution of the release audit (35 findings, issues #2–#36). The webview is treated as **untrusted** and the Rust backend as the trust boundary: path access is canonicalized, AI base URLs are allowlisted, API keys never leave the Keychain, and every Tauri command is scoped by the capabilities ACL. All changes are **backward compatible** — no breaking API or config changes.

#### 🐛 Bug Fixes

- **Vault path traversal (critical)** — `safe_path` now canonicalizes and verifies containment: absolute paths, `..` escapes, and symlink escapes are rejected, while not-yet-existing targets (create/write) are still accepted via their deepest existing ancestor
- **SSRF + API key exfiltration (critical)** — AI base URLs are allowlisted to provider endpoints (models.dev catalog + loopback for local LLM servers); `http` to remote hosts, private/link-local IPs, and non-allowlisted hosts are rejected; the API key is always resolved from the Keychain and a webview-provided key is ignored
- **Stored XSS via markdown HTML** — `md_to_html` / `markdown_preview` now render with raw HTML disabled and ammonia-sanitize the output (script/iframe/event handlers/`javascript:` URLs stripped)
- **Unbounded AI response buffering** — 8 MiB cap with a `truncated` flag on `ai:done` (memory-exhaustion guard)
- **Internal error details leaked to the UI** — transport errors map to user-safe messages; HTTP errors show only the status, never the provider body/URLs
- **IPC authorization** — all 31 Tauri commands are scoped via the capabilities ACL (`allow-*` permissions, canonical Tauri format); strict production CSP (`script-src 'self'`, `base-uri`/`form-action`/`frame-ancestors`/`object-src` none) + relaxed `devCsp` for the react-refresh preamble; prototype-pollution freeze applied after module evaluation in `main.tsx` (Tauri's `freezePrototype` config injected pre-load and crashed zod/xl-ai, which assign `Object.prototype.toString` during evaluation)
- **API keys readable from the webview** — `get_api_key` removed entirely; the Settings key input is local state and never loads or displays the stored key; the AI transport no longer sends the key
- **Filenames in auto-commit messages** — control chars/newlines and trailing dots stripped
- **`git_status` polled twice** — Editor (3s) + StatusBar (5s) replaced by a single shared poller; per-tab state derives from it
- **Search modal keyboard navigation did not scroll** — ArrowUp/Down moved the highlight past the visible area; the list now scrolls the selected result into view (`block: nearest`)
- **openai/anthropic/google direct connect broken** — their `api` fields were empty in the provider catalog; filled with canonical endpoints

#### 🚀 Features

- **Git settings UI** — Settings modal (⌘,) now has AI + Git tabs: commit identity (per-vault, global config untouched), remote add/remove, and in-app **Initialize git repository** (no terminal needed)
- **Clone repository** — welcome screen flow with URL input, remote-only validation (no local paths/`file://`), anti-traversal folder naming, and clear private-repo guidance
- **Graceful shutdown** — window close emits `app:before-close` → the frontend saves every dirty tab → confirms; 3s force-close fallback if the frontend hangs
- **Error boundary** — a render crash shows a recovery screen with Reload instead of a blank window
- **Health/diagnostics command** — version / vault-open / git-repo status for the future cloud service
- **Wiki (Obsidian-style wikilinks)** — `[[Note]]` resolution to real files, backlinks with one-line context snippets (previously always empty), a note-search **Link note** button in the formatting toolbar that inserts `[[wikilink]]` at the cursor, and snippets in the sidebar Backlinks panel
- **Basic backend logging** — lifecycle logs for vault open and AI request start/done

#### 🧹 Cleanup

- **Dead Tauri commands pruned** — `vault_info`, `wiki_suggest` removed (never called); SSE parsing already unified in a single dispatcher
- **Unused `@mantine/utils` (v6) removed** — eliminates the v6/v9 version skew with `@mantine/core@9`
- **Providers catalog lazy-loaded** — 621 KB chunk split out of the initial bundle (2.17 MB → ~1.5 MB)
- **Rust toolchain pinned** (`rust-toolchain.toml`, 1.94.1) — deterministic local builds and CI
- **CI hardened** — version-consistency check, `npm audit` + `cargo audit` + Dependabot, publish job fails loudly (no `|| true`), pinned runners (macOS 14 / Ubuntu 22.04), pre-commit runs `lint-staged`
- **macOS 12 minimum enforced** in the bundle config
- **Repo hygiene** — `.editorconfig`, `.gitattributes`, `.npmrc`, `.env` ignored
- **Docs reorganized** — README is end-user only (install/first-run/troubleshooting, corrected provider/model counts, clarified GPL commercial clause); developer content moved to `CONTRIBUTING.md`; `SECURITY.md` + issue/PR templates + CODEOWNERS added

---

## v0.1.0-alpha.5 — 2026-08-03

### Editor stability & vault onboarding

Undo/redo reliability fixes and a proper first-run experience: welcome screen, vault creation, and recent vaults. All changes are **backward compatible** — no breaking API or config changes.

#### 🐛 Bug Fixes

- **Undo/redo crash** — the toolbar state read `_tiptapEditor.can().undo()` which does not exist (BlockNote registers history as a prosemirror plugin, not a TipTap command), throwing a `TypeError` on every editor change. Availability is now read from the history plugin via `undoDepth`/`redoDepth`
- **Undo/redo falsely enabled on untouched documents** — the initial content load (`replaceBlocks`) was recorded in undo history, so a freshly opened file showed enabled buttons and Cmd+Z reverted the load back to blank. The load transaction now runs with `addToHistory: false`, keeping history empty until the user actually edits
- **AI button appeared active in markdown mode** — the Sparkles button only works while the WYSIWYG editor is mounted, but stayed enabled in markdown mode (and for `.mdx`/preview files). It is now disabled whenever the WYSIWYG editor isn't rendered, with a tooltip explaining why
- **Search/New shortcuts ran without a vault** — ⌘F/⌘P/⌘N and the sidebar search/plus buttons acted as if a vault were open. They are now disabled (with a toast prompt) until a vault is opened
- **Shortcut reference missing BlockNote format shortcuts** — the built-in reference (status bar `?` modal + README) merged the markdown input rules into a single row and omitted BlockNote's real format shortcuts (`Ctrl/Cmd+Shift+6`–`9`, `Ctrl/Cmd+Alt+Q`/`0`). Input rules are now listed per format and the keyboard shortcuts are documented
- **Mode switch shortcut moved to Ctrl/Cmd+Shift+E** — ⌘E collided with BlockNote's inline-code mark (both actions fired on one keypress: ProseMirror applies code, the app toggles mode). The WYSIWYG/Markdown toggle now lives on ⌘⇧E (handler, TabBar tooltip, shortcuts modal, and README updated); ⌘E inside the editor is freed for inline code
- **Sidebar collapse was invisible** — the sidebar could only be toggled via ⌘J with no visible affordance. Added a collapse button in the sidebar header and a slim expand strip on the left edge when collapsed, both with ⌘J tooltips
- **Tailwind padding/margin utilities were silently dead** — the unlayered universal reset (`* { margin: 0; padding: 0 }`) in `index.css` overrode every Tailwind v4 utility (`.p-*`, `.m-*`, `space-y-*` live in `@layer utilities`, and unlayered rules beat layered ones regardless of specificity). Tree rows sat flush against the top-bar border, bottom-bar buttons lost their padding, and spacing was inconsistent app-wide — masked by inline styles. The reset now lives in `@layer base`, restoring the intended layout everywhere
- **Scrollbars were always visible** — the custom `::-webkit-scrollbar` styling forced WebKit into classic mode, painting scrollbars permanently on every overflowing container (tree, tab strip, modals) even when idle. Removed the styling: macOS overlay scrollbars now appear only while the user is actually scrolling

#### 🧹 Cleanup

- **Inline styles converted to Tailwind utilities** — 121 `style={{...}}` props across 7 components (App, Sidebar, Editor, ShortcutsModal, StatusBar, GraphView, AiSettingsModal) replaced with JIT classes, now that utilities actually apply (tree indentation became `depth-0`–`depth-12` CSS classes). Visually verified via headless computed-style audit (padding, radius, width, shadow identical to the old inline values); the only 3 remaining inline styles are runtime pixel positioning (context menu, dropdown popups) which static classes cannot express

#### 🚀 Features

- **Welcome screen** — when no vault is open, a Zed-style launchpad offers Open Folder, Create Vault, and recent vaults instead of an empty editor
- **Create Vault** — new vault folders can be created directly from the welcome screen (backend `create_vault` command with name validation: no path separators, dots, or traversal)
- **Recent vaults** — the last 5 opened vaults are remembered (localStorage) for one-click reopening; the open-folder dialog defaults to the most recent vault's parent; deleted vaults are dropped from the list with a toast

---

## v0.1.0-alpha.4 — 2026-08-02

### AI backend hardening

Foundation improvements to the Rust AI streaming pipeline and error UX. All changes are **backward compatible** — no breaking API or config changes.

#### 🐛 Bug Fixes

- **Replace selection + AI returns extra blocks** — when the model produces more blocks than the selection (very common for improve/rewrite), extra blocks received `id: "undefined$"` causing semantic validation rejection and a silent toast. Extra blocks are now appended as a single `add` operation after the last selected block
- **AI streaming total timeout cuts long generations** — `reqwest::Client::timeout()` is a total deadline; long generations from slow/local models were cut off at 120s. Replaced with `read_timeout` (per-chunk idle, resets on each read) — long streams survive as long as bytes keep flowing
- **User abort never stopped backend** — when xl-ai cancels a request (user closes menu, new request), the Rust `ask_ai` stream continued until completion or 120s timeout. Now a `cancel_ai` command sets an `AtomicBool` flag checked per chunk; frontend wires the abort signal to invoke it
- **AI error state not shown in xl-ai's own UI** — when the retry loop exhausted or output could not be parsed into document operations, the AI menu closed silently (only a toast appeared). Now `controller.error()` is emitted so xl-ai's built-in AIMenu renders the error state with **retry + cancel** buttons (`getDefaultAIMenuItemsForError`)

#### 🧹 Cleanup

- **Dead legacy tool validation removed** — `ApplyBlocksInput`, `Cursor`, `validate_tool_call`, and 7 tests for `apply_blocknote_blocks` deleted (unused since the transport switched to xl-ai's own `applyDocumentOperations`)
- **Dead** `agent::from_env` **removed** — the keychain-fallback constructor was never called (frontend always passes explicit provider/config) and hardcoded an incorrect `base_url` for Anthropic (Anthropic natively uses a different API format)
- **Provider field now emitted** in `ai:done` event (previously an unused field with a `let _ =` suppress)

---

## v0.1.0-alpha.3 — 2026-08-01

### AI editing polish

Fixes to the xl-ai integration: the AI entry point in the bubble menu, AI auto-scroll during writing, and shortcut documentation cleanup. All changes are **backward compatible** — no breaking API or config changes.

#### 🐛 Bug Fixes

- **AI auto-scroll stops when suggestion exceeds viewport** — xl-ai's built-in auto-scroll self-disables once content outgrows the screen: its scroll-event race (a new scroll before the previous `scrollend`) permanently kills `autoScroll` under streaming, so the editor stopped following the writing position. Replaced with an app-side follower: while the AI writes, a `MutationObserver` on the editor DOM re-centers the current writing block on every token append, stopping only on real user input (wheel/touch/scroll keys) and re-arming on the next AI run
- **Shortcut reference cleanup** — ghost `Ctrl/Cmd+Enter` "Run AI prompt" (never implemented) removed; `Ctrl+Alt+L` relabeled from "Toggle AI panel" to "Ask AI / Write with AI (opens AI menu at cursor)"; BlockNote built-in editor shortcuts now documented in the reference (status bar `?` modal + README): Tab/Shift+Tab indent, Enter/Shift+Enter, Cmd+B/I/U/K, Cmd+Alt+1–5 heading levels, and markdown input rules (`#`, `-`, `1.`, `[]`, `>`, `space`)

#### 🚀 Features

- **Bubble menu AI entry** — the formatting toolbar (bubble menu on text selection) is replaced with the default items + xl-ai's `AIToolbarButton`; selecting text now opens the AI text prompt with selection-aware commands (improve writing, fix spelling, translate, simplify) and a custom prompt input

---

## v0.1.0-alpha.2 — 2026-08-01

### reliability iteration

Post-release hardening pass over the initial alpha: AI transport corruption, WebKit rendering, Git integration, and API-key persistence. All changes are **backward compatible** — no breaking API or config changes.

#### 🐛 Bug Fixes

- **AI stream corruption (root cause)** — SSE parsing in `ask_ai` rewritten to a byte-buffered decoder: raw bytes are buffered across chunks, split on `\n`, and each complete line decoded as one UTF-8 unit. Fixes JSON split mid-event (dropped/duplicated operations) and multi-byte UTF-8 characters corrupted by per-chunk `String::from_utf8_lossy` — the root cause of garbage output from low-level models
- **AI output over-rejection removed** — the unknown-word quality gate (`wordlist.ts`) was deleted entirely. It rejected legitimate content (proper nouns, tech terms), so models could not write anything. The transport fix above is the real guard; content is always written and reviewed via accept/reject
- **Git branch not displayed** — `git_status` returned invalid JSON (literal newline in `git status --porcelain` output) breaking the frontend `JSON.parse`; now serialized with `serde_json::json!`
- `is_repo()` **regression** — status check now uses exit status (`output().status.success()`), fixing terminal spam and false negatives
- **WYSIWYG → Markdown data loss** — mode toggle now flushes the editor to the store before switching, so edits are never lost when leaving WYSIWYG
- **WebKit drag-and-drop blocked** — removed the global `user-select: none` which aggressively blocks text selection and drag in Safari/WKWebView (child overrides ignored). UI shells now opt in individually via a shared `.ui-shell` class
- **HTML5 drag-and-drop in WKWebView** — Tauri's native DND handler hijacks window-level drag events; `dragDropEnabled: false` in window config restores in-page HTML5 drag (BlockNote block drag)
- **API keys lost across processes** — `keyring` crate replaced with a `keychain.rs` wrapper over the macOS `security` CLI, which persists per-provider keys reliably across app restarts
- **Key storage security** — API keys are now macOS Keychain-only; the localStorage fallback was removed
- **Polling toast spam** — Git-status toast removed (was re-showing every 3s poll)
- **MDX fallback removed** — `mdx.ts` deleted; `.mdx` files are forced to source mode (never WYSIWYG), other file types open as read-only preview
- **CSS hardcoded colors** — scattered hex literals consolidated into CSS custom properties (`:root` tokens), single source of truth for theming

#### 🚀 Features

- **AI transport hardening (xl-ai)** — `sendMessages` now grounds the model with the actual document state (markdown, capped at 12k chars) + task-specific formatting rules, so output is document-aware instead of generic
- **Semantic validation + retry** — tool-call output is validated (`validateOperationsSemantics`: referenced block ids must exist); invalid output triggers an automatic retry with error feedback (`MAX_AI_ATTEMPTS = 2`) instead of corrupting the document
- **opencode gateway attribution** — `x-opencode-client: pi` header + session id, mirroring PI's provider attribution for correct opencode-go routing
- **File classification** (`fileKind`) — single helper classifies files: `.md`/`.markdown` toggleable WYSIWYG, `.mdx` forced source, everything else read-only preview
- **Markdown source placeholder** — "Start writing in Markdown…" in source mode
- **Production context-menu suppression** — native browser menu (Reload/Back) suppressed in production builds; right-click devtools preserved in dev
- **Per-provider settings restore** — model + API key restored when switching providers; keychain key re-fetched on startup/HMR

#### 🔧 Technical

- **New files**: `src-tauri/src/keychain.rs` (macOS `security` CLI wrapper), `src/utils/aiBlocks.ts` (+ tests) — markdown normalization, formatting rules, operation validation
- **Removed**: `src/utils/mdx.ts` (+ test), `src/utils/wordlist.ts`, `keyring` crate
- **Tests**: 37 Rust (SSE chunking incl. UTF-8 split + CRLF, tool-call validation) + 37 frontend (aiBlocks, aiSettings), all passing
- **tauri.conf.json**: `dragDropEnabled: false` to restore HTML5 DnD

#### ⚠️ Known Issues & Limitations

- Tool call support depends on provider/model compatibility — not all models implement function calling correctly
- OpenCode Go provider has limited `tool_choice` support
- `.mdx` files are source-mode only (never WYSIWYG)
- macOS 12+ required (WebKit minimum)
- API and configuration format may change without migration path in alpha

---

## v0.1.0-alpha.1 — 2026-07-29

### alpha release

**DocuBook** is a vault-based document editor with WYSIWYG block editing, AI assistant, and Git integration. Built with Tauri v2 (Rust) + BlockNoteJS (React).

This is the initial **alpha** release. The API and feature set are **not stable** and may change significantly between versions. Breaking changes should be expected.

#### 🚀 Features

- **Vault System** — Open any folder as a vault; file tree with depth-based indentation, CRUD operations, search by filename, frontmatter auto-extraction
- **WYSIWYG Block Editor** — Notion-like block editor (BlockNoteJS) with slash commands, bubble menu, headings, lists, code blocks, tables, and markdown source mode toggle
- **AI Assistant** — Inline AI powered by BlockNote XL (`@blocknote/xl-ai`) with custom Rust backend (`ask_ai` Tauri command)
  - 174 providers with 5,811 models auto-synced from [models.dev](https://models.dev)
  - Tool call support (4,675 models) for structured document operations
  - Text-only fallback with markdown parsing for models without tool call support
  - Per-provider API key storage (macOS Keychain + localStorage)
  - Keyboard shortcut: `Ctrl+Alt+L`
- **Git Integration** — Stage, commit + push with auto-generated messages, branch display in status bar
- **Sidebar** — File tree, file search modal, backlinks panel, CRUD operations
- **GitHub Actions CI** — Build for Intel + Apple Silicon, auto-generated release notes
- **Keyboard Shortcuts** — Toggle sidebar (`Ctrl+J`), file search (`Ctrl+F`/`Ctrl+P`), open vault (`Ctrl+O`), AI panel (`Ctrl+Option+L`)

#### 🔧 Technical

- **Stack**: Rust (Tauri v2) / React 19 / TypeScript / BlockNoteJS / Zustand
- **Keychain Integration**: API keys stored in macOS Keychain with per-provider localStorage fallback
- **SSE Streaming**: Real-time AI response streaming via Server-Sent Events parsed in Rust, forward to frontend as UIMessageChunk stream
- **Provider Data**: Auto-generated from `models.dev/api.json` — run `curl https://models.dev/api.json` for latest
- **Unit Tests**: 30+ tests across Rust (SSE parsing, tool call accumulation, markdown rendering, config, vault, wiki) and frontend (zustand store, MDX extraction)
- **License**: [GPL-3.0](LICENSE)

#### ⚠️ Known Issues & Limitations

- Tool call support depends on provider/model compatibility — not all models implement function calling correctly
- OpenCode Go provider has limited tool_choice support
- MDX files only work in source mode (WYSIWYG mode shows plain text)
- macOS 12+ required (WebKit minimum)
- API and configuration format may change without migration path in alpha

---

## Versioning

This project follows **manual versioning** (not semver). Versions are:

- `0.1.x-alpha.N` — Alpha releases. Features, API, and configuration format are UNSTABLE. Breaking changes expected at any time.
- `0.x.0-beta` — Future beta releases. API stabilization begins.
- `1.x.0` — Future stable releases.

See [README.md](README.md) for documentation and setup guide.
