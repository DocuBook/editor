# DocuBook Editor

A **vault-based** document editor with **WYSIWYG block editing**, **AI assistant**, and **Git integration**.
Built with Tauri v2 (Rust) + BlockNoteJS (React).

> The markdown editor that thinks like a developer — Obsidian vaults, Notion blocks, Zed-speed search and git. All in one

***

## Features

### Vault System (Obsidian-like)

- Open any folder as a vault — your files stay local, no lock-in
- File tree with depth-based indentation, dotfiles support
- CRUD — create files/folders, rename, delete via right-click context menu
- Search files by filename (like Zed/Obsidian Cmd+F)
- Frontmatter (YAML) auto-extracted, preserved during edits
- **.md** files open in WYSIWYG editor (fully supported)
- **.mdx** support in development — currently only works in source/markdown mode
- All other file types (JSON, TOML, YAML, etc.) open in view-only mode

### WYSIWYG Block Editor (Notion-like)

- BlockNoteJS — Notion-style block-based rich text editor
- Slash command menu (`/`) to insert headings, lists, quotes, code blocks, dividers
- Bubble menu for inline formatting (bold, italic, code, link, highlight)
- Markdown source mode — toggle between WYSIWYG and raw markdown
- **.md files only** — WYSIWYG mode supports standard CommonMark markdown
- **MDX support in development** — MDX components fall back to plain text in WYSIWYG; edit in source mode instead

### AI Assistant

- Inline AI powered by BlockNote XL (`@blocknote/xl-ai`) + custom Rust backend
- Slash menu and toolbar AI commands: write, improve, summarize, translate, fix spelling, and more
- Keyboard shortcut: `Ctrl+Alt+L` to open AI menu
- Configure API keys in-app via **Settings** (gear icon in sidebar) — stored in macOS Keychain + localStorage
- **174 providers** with **5,811 models** — auto-synced from [models.dev](https://models.dev)

> [!NOTE]
> **Tool Call Support**  
> AI models that support **function/tool calling** (4,675 of 5,811 models) can generate structured document operations (headings, lists, code blocks, tables) instead of plain markdown text.  
> When the selected model supports tool calls, the editor uses xl-ai's native suggestion workflow (accept/reject). Otherwise, it falls back to direct text insertion with markdown parsing.

**Popular Providers:**

| Provider | Models | Tool Calls | Notes |
|----------|--------|------------|-------|
| OpenAI | gpt-4o-mini, gpt-4o, gpt-5.6 | ✅ | Best overall quality, reliable tool calls |
| Anthropic | claude-haiku-4.5, sonnet-4, opus-5 | ✅ | Excellent for long documents |
| Google Gemini | gemini-2.0-flash, 2.5-pro, 3.6-flash | ✅ | Cheapest capable models |
| DeepSeek | v4-flash, reasoner, v4 | ✅ | Via deepseek.com or gateways |
| Mistral AI | small, medium, large | ✅ | Good quality/price ratio |
| Groq | llama-3.1-8b, llama-3.3-70b | ✅ | Free tier available, fastest inference |
| Cohere | command-r7b, command-a | ✅ | Good for RAG workflows |
| Perplexity | sonar, sonar-pro | ✅ | Web-augmented generation |

> [!TIP]
> For the best experience with structured content (headings, code blocks, lists), choose a model with tool call support. For simple text generation, all models work via the markdown fallback path.

**Provider data** is auto-generated from [models.dev/api.json](https://models.dev/api.json) — an open-source database of AI model specs, pricing, and capabilities. Run `curl https://models.dev/api.json` to get the latest data.

Configure your API key in **Settings** (gear icon in sidebar). Keys are stored in macOS Keychain with a localStorage fallback per provider.

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
| Editor     | BlockNoteJS v3 (ProseMirror)    |
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

> **Note:** Only `.md` files are fully supported in WYSIWYG mode. For `.mdx` files or content with MDX components, use **source mode** (Code button) instead.

### Keyboard Shortcuts

| Shortcut                    | Action                      |
| --------------------------- | --------------------------- |
| `Ctrl/Cmd+J`                | Toggle sidebar              |
| `Ctrl/Cmd+F` / `Ctrl/Cmd+P` | Open file search            |
| `Ctrl/Cmd+O`                | Open vault / project folder |
| `Ctrl+Alt+L`                | Toggle AI panel             |
| `Ctrl/Cmd+Enter`            | Run AI prompt               |
| `/` (in editor)             | Slash command menu          |
| `↑` / `↓` / `Enter`         | Navigate search results     |
| `Enter` (on create/rename)  | Confirm                     |
| `Escape` (on create/rename) | Cancel                      |

***

***

## Project Structure

```text
src/
  components/
    Editor.tsx       WYSIWYG + Markdown modes
    Sidebar.tsx      Vault tree, search, CRUD, context menu
    StatusBar.tsx    Git branch indicator
    GraphView.tsx    Note graph visualization
  stores/
    editor.ts        Tabs, file content, edited content
    vault.ts         Vault state, tree, folder expansion
  App.tsx            Root layout
src-tauri/src/
  lib.rs             Tauri commands
  vault/             File system vault
  wiki/              Wikilink index
  git/               Git add-commit-push
  search/            Filename search
  config/            docu.json config
  agent/             AI agent (OpenAI/Anthropic)
```

***

## License

[GPL-3.0](./LICENSE) — DocuBook now integrates BlockNote XL package (`@blocknote/xl-ai`) which is licensed under GPL-3.0. The GPL ensures that modified versions of the app remain free and open — if you distribute the app, you must share your changes under the same license.