# DocuBook Editor

A **vault-based** editor that combines **WYSIWYG blocks**, an **AI assistant**, and **Git integration** — built with Tauri v2 (Rust) and BlockNoteJS (React).

> The markdown editor that thinks like a developer — Obsidian vaults, Notion blocks, Zed-speed search, and Git — all in one.

***

## Features

### Vault System (Obsidian-like)

- Open any folder as a vault — your files stay local, no lock-in
- File tree with depth-based indentation, dotfiles support
- CRUD — create files/folders, rename, delete via right-click context menu
- Search files by filename (like Zed/Obsidian Cmd+F)
- Frontmatter (YAML) auto-extracted, preserved during edits
- **.md** files open in WYSIWYG editor (fully supported)
- **.mdx** files open in markdown/source mode only (never WYSIWYG)
- All other file types (JSON, TOML, YAML, etc.) open in view-only mode

### WYSIWYG Block Editor (Notion-like)

- BlockNoteJS — Notion-style block-based rich text editor
- Slash command menu (`/`) to insert headings, lists, quotes, code blocks, dividers
- Bubble menu for inline formatting (bold, italic, code, link, highlight)
- Markdown source mode — toggle between WYSIWYG and raw markdown
- **.md files only** — WYSIWYG mode supports standard CommonMark markdown
- **.mdx is source-mode only** — MDX files never open in WYSIWYG; edit in markdown source instead

### AI Assistant

- Inline AI powered by BlockNote XL (`@blocknote/xl-ai`) + custom Rust backend
- Slash menu and toolbar AI commands: write, improve, summarize, translate, fix spelling, and more
- Keyboard shortcut: `Ctrl+Alt+L` to open AI menu
- API keys configured in **Settings** — stored in macOS Keychain only, never localStorage
- **174 providers** with **5,811 models** — auto-synced from [models.dev](https://models.dev)

> [!NOTE]\
>  **Every AI response becomes a reviewable suggestion.** The editor converts model output into `applyDocumentOperations` — either from the model's own tool call (`toolCall: true` models, ≈4,675 across 172 providers) or generated from plain-text output (models without tool-call support, incl. `opencode-go`). In both cases the result appears as a tracked-change suggestion with **accept/reject** buttons before it touches the document. Output is guarded: referenced block ids must exist in the document (invalid ids trigger an automatic retry), and unclosed code fences are auto-closed before parsing.

**Popular Providers** (all support the accept/reject suggestion flow):

| Provider      | Notable models                       |
| ------------- | ------------------------------------ |
| OpenAI        | gpt-4o-mini, gpt-4o, gpt-5.6         |
| Anthropic     | claude-haiku-4.5, sonnet-4, opus-5   |
| Google Gemini | gemini-2.0-flash, 2.5-pro, 3.6-flash |
| DeepSeek      | v4-flash, reasoner, v4               |
| Mistral AI    | small, medium, large                 |
| Groq          | llama-3.1-8b, llama-3.3-70b          |
| Cohere        | command-r7b, command-a               |
| Perplexity    | sonar, sonar-pro                     |

**Provider data** is auto-generated from [models.dev/api.json](https://models.dev/api.json) — an open-source database of AI model specs, pricing, and capabilities. Run `curl https://models.dev/api.json` to get the latest data.

### Git Integration

- Save — stage all changes (git add -A)
- Publish — commit + push with auto-generated message
- Git branch displayed in status bar
- Disabled state tracking — Publish only enabled after staging

### Sidebar

- Vault file tree with expandable folders
- Search files modal (filename-based, recursive)
- Backlinks panel for current file (wikilinks)
- Bottom toolbar: Open vault, Search files, New file/folder

***

## Stack

| Layer      | Tech                            |
| ---------- | ------------------------------- |
| Frontend   | React 19, TypeScript 6, Zustand |
| UI         | Tailwind CSS v4, Lucide icons   |
| Editor     | BlockNoteJS 0.52 (ProseMirror)  |
| Backend    | Rust with Tauri v2              |
| Build      | Vite 8 + Rolldown               |
| Markdown   | pulldown-cmark (Rust)           |

***

## Prerequisites

- **macOS** 12 (Monterey) or later
- **Node.js** >= 22
- **Bun** or npm
- **Rust** toolchain (rustup)
- **Tauri v2 system dependencies** — see https://v2.tauri.app/start/prerequisites/

***

## Build from Source

```text
git clone https://github.com/DocuBook/editor.git
cd editor
npm install
npm run tauri dev        # dev mode with hot reload
npm run tauri build      # production build
```

### Cross-compile

```text
# Intel Macs
rustup target add x86_64-apple-darwin
npm run tauri build -- --target x86_64-apple-darwin

# Apple Silicon
rustup target add aarch64-apple-darwin
npm run tauri build -- --target aarch64-apple-darwin
```

***

## Usage

1. Launch the app — click Open Vault (folder icon in sidebar)
2. Select a folder containing .md files
3. Click a file in the sidebar tree — opens in WYSIWYG editor
4. Type `/` for slash commands, select text for bubble formatting
5. Use Code button to toggle between editor / markdown source
6. Save — stages changes, Publish — commit + push
7. Toggle AI in toolbar for AI assistance

> **Note:** Only `.md` files are fully supported in WYSIWYG mode. `.mdx` files are source-mode only and never open in WYSIWYG.

### Keyboard Shortcuts

| Shortcut                    | Action                      |
| --------------------------- | --------------------------- |
| `Ctrl/Cmd+J`                | Toggle sidebar              |
| `Ctrl/Cmd+F` / `Ctrl/Cmd+P` | Open file search            |
| `Ctrl/Cmd+O`                | Open vault / project folder |
| `Ctrl/Cmd+E`                | Toggle WYSIWYG / Markdown   |
| `Ctrl/Cmd+Z` / `+Shift+Z`   | Undo / Redo                 |
| `Ctrl/Cmd+N`                | New file                    |
| `Ctrl/Cmd+Alt+N`            | New folder                  |
| `Ctrl+Alt+L`                | Toggle AI panel             |
| `Ctrl/Cmd+Enter`            | Run AI prompt               |
| `Ctrl/Cmd+,`                | AI Settings                 |
| `/` (in editor)             | Slash command menu          |
| `↑` / `↓` / `Enter`         | Navigate search results     |
| `Enter` (on create/rename)  | Confirm                     |
| `Escape` (on create/rename) | Cancel                      |

***

## Project Structure

```text
src/
  main.tsx              Entry point
  App.tsx               Root layout, keyboard shortcuts
  components/
    Editor.tsx          WYSIWYG + Markdown modes, AI transport (xl-ai ↔ Rust)
    Sidebar.tsx         Vault tree, search, CRUD, context menu
    StatusBar.tsx       Git branch indicator
    GraphView.tsx       Note graph visualization
    AiSettingsModal.tsx Provider/model/API-key settings (keychain)
    ShortcutsModal.tsx  Keyboard shortcuts reference
  stores/
    editor.ts           Tabs, file content, edited content
    vault.ts            Vault state, tree, folder expansion
    aiSettings.ts       Provider/model/saved-providers (persisted) — API keys live only in keychain
  data/
    providers.ts        Auto-generated provider/model catalog (models.dev)
  hooks/
    useKeyboard.ts      Keyboard shortcut handling
    usePolling.ts       Interval polling (git status)
    useClickOutside.ts  Click-outside detection for menus
  utils/
    aiBlocks.ts         AI text → applyDocumentOperations (suggestions)
src-tauri/src/
  lib.rs                Tauri commands (vault, wiki, git, search, AI)
  keychain.rs           macOS Keychain access via `security` CLI
  agent/                AI agent config (provider/model/base URL)
  vault/                File system vault
  wiki/                 Wikilink index
  git/                  Git add-commit-push
  search/               Filename search
  config/               docu.json config
```

***

## License

[GPL-3.0](./LICENSE) — DocuBook now integrates BlockNote XL package (`@blocknote/xl-ai`) which is licensed under GPL-3.0. The GPL ensures that modified versions of the app remain free and open — if you distribute the app, you must share your changes under the same license.