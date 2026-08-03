# Changelog

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
