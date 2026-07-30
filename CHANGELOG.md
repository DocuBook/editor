# Changelog

## v0.1.0-alpha — 2026-07-29

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

- `0.1.x-alpha` — Alpha releases. Features, API, and configuration format are UNSTABLE. Breaking changes expected at any time.
- `0.x.0-beta` — Future beta releases. API stabilization begins.
- `1.x.0` — Future stable releases.

See [README.md](README.md) for documentation and setup guide.
