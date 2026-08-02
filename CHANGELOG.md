# Changelog

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
