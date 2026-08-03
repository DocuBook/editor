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
- **174 providers** with **5,482 models** (verified from `providers.ts`) — auto-synced from [models.dev](https://models.dev)

> [!NOTE]\
>  **Every AI response becomes a reviewable suggestion.** The editor converts model output into `applyDocumentOperations` — either from the model's own tool call (`toolCall: true` models, 5,429 across 172 providers) or generated from plain-text output (models without tool-call support, incl. `opencode-go`). In both cases the result appears as a tracked-change suggestion with **accept/reject** buttons before it touches the document. Output is guarded: referenced block ids must exist in the document (invalid ids trigger an automatic retry), and unclosed code fences are auto-closed before parsing.

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

## Build from Source

See [CONTRIBUTING.md](./CONTRIBUTING.md) for prerequisites, building, cross-compiling, and the project layout.

***

## Install & Getting Started

1. **Install** — download the DMG from the [Releases](https://github.com/DocuBook/editor/releases) page and drag DocuBook into Applications. (First launch: macOS may ask to confirm an unsigned build — right-click → Open, then confirm.)
2. **Open or create a vault** — on the welcome screen choose **Open Folder** (an existing folder of `.md` files), **Create New Vault**, or **Clone Repository** (paste a git URL to pull a vault from GitHub/GitLab).
3. **Connect AI (optional)** — press `⌘,` → **AI** tab, pick a provider, paste your API key, Save. Keys are stored in the macOS Keychain and never leave your machine.
4. **Set up git publishing (optional)** — press `⌘,` → **Git** tab: set your commit name/email and add a remote. Private repos use your macOS Keychain / SSH keys automatically.
5. **Start writing** — click a file in the sidebar. Type `/` for slash commands; select text for the formatting toolbar; use the **Code** button to toggle WYSIWYG/markdown.

> **Troubleshooting:** AI not responding? Check the provider key in Settings → AI and that your network allows the provider endpoint. Git publish failing? Check Settings → Git for identity/remote, and that your SSH key or credential helper is set up on this machine.

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
| `Ctrl/Cmd+Shift+E`          | Toggle WYSIWYG / Markdown   |
| `Ctrl/Cmd+Z` / `+Shift+Z` / `+Y` | Undo / Redo |
| `Ctrl/Cmd+N`                | New file                    |
| `Ctrl/Cmd+Alt+N`            | New folder                  |
| `Ctrl+Alt+L`                | Ask AI / Write with AI (opens AI menu at cursor) |
| `Ctrl/Cmd+,`                | Settings (AI + Git)         |
| `/` (in editor)             | Slash command menu          |
| `↑` / `↓` / `Enter`         | Navigate search results     |
| `Enter` (on create/rename)  | Confirm                     |
| `Escape` (on create/rename) | Cancel                      |

Writing shortcuts (built-in, no setup needed):

| Shortcut                    | Action                      |
| --------------------------- | --------------------------- |
| `Tab` / `Shift+Tab`         | Indent / outdent block      |
| `Enter` / `Shift+Enter`     | New block / line break      |
| `Ctrl/Cmd+B` / `+I` / `+U` / `+K` / `+Shift+S` | Bold / Italic / Underline / Link / Strike |
| `Ctrl/Cmd+E` | Inline code |
| `Shift+Cmd+↑` / `+↓` | Move block up / down |
| `Ctrl/Cmd+Alt+0` | Paragraph |
| `Ctrl/Cmd+Alt+1`–`5` | Heading level 1–5 |
| `Ctrl/Cmd+Alt+Q` | Quote |
| `Ctrl/Cmd+Shift+6` | Toggle list |
| `Ctrl/Cmd+Shift+7` | Numbered list |
| `Ctrl/Cmd+Shift+8` | Bullet list |
| `Ctrl/Cmd+Shift+9` | Checklist |
| `#` + `Space` | Toggle heading |
| `-` + `Space` | Toggle bullet list |
| `1.` + `Space` | Toggle numbered list |
| `[]` + `Space` | Toggle checklist |
| `>` + `Space` | Toggle quote |
| ` ``` ` + `Space` | Toggle code block |

***

## License

[GPL-3.0](./LICENSE) — DocuBook now integrates BlockNote XL package (`@blocknote/xl-ai`) which is licensed under GPL-3.0. The GPL ensures that modified versions of the app remain free and open — if you distribute the app, you must share your changes under the same license.

### Commercial Use

**GPL-3.0 permits commercial use** — you may sell the app, host it as a service, or use it internally, as long as you comply with the copyleft obligations (offer source, keep it under GPL-3.0, preserve notices). No permission is required for standard commercial use.

The **optional cooperation clause** below is a separate, voluntary arrangement — it is NOT a GPL requirement and does not restrict what the license already permits:

> If you would like to work with the author directly — for example, running DocuBook as a dedicated managed service or building an AI gateway/provider on top of it — reach out to arrange cooperation: [email@wildan.dev](mailto:email@wildan.dev)

> [!NOTE]
> **Personal and community use remains free forever.** Using DocuBook for yourself, your studies, or your community — on your own devices or your own server — always stays free and open source.