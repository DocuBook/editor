# Product Requirements Document — Editor

## Product Vision
Desktop editor untuk menulis markdown — menggabungkan kecepatan **Zed**,
fleksibilitas manajemen catatan **Obsidian**, dan layer publishing **DocuBook**.
Satu alat untuk menulis catatan pribadi sekaligus dokumentasi project yang bisa
di-publish ke static HTML.

## Target User
- Developer documentation writer
- Technical writer
- Knowledge worker (note-taking + publishing)
- Indie developer / small team

## Core Features

### P0 (MVP)
1. **Vault management** — open folder sebagai vault, file tree CRUD
2. **Markdown editor** — CodeMirror 6, syntax highlighting, split preview
3. **Preview pane** — render markdown via `@docubook/mdx-content` (identik final)
4. **Zed-like UI** — minimal chrome, dark/light theme, tab bar, status bar
5. **DocuBook project support** — `docu.json` editor, git push trigger

### P1
6. **Wiki links** — `[[wikilink]]` autocomplete, backlinks, unlinked mentions
7. **Tags** — inline `#tag`, frontmatter tags, tag pane
8. **Full-text search** — vault-wide, filter by path/tag/date

### P2
9. **File watcher** — deteksi perubahan eksternal, auto-refresh
10. **Graph view** — D3.js visualisasi koneksi antar note
11. **AI agent** — inline AI assistant (SSE streaming)

## Non-Functional Requirements
- Native desktop: Wails (Go + WebView)
- Bundle size: ~10-20MB
- Startup time: <1 detik
- macOS 10+ (arm64 + x64)
- Zero mandatory internet (kecuali AI agent & git push)

## Competitive Landscape
| Aspek | Editor Ini | Zed | Obsidian | VS Code | Typora |
|-------|-----------|-----|----------|---------|--------|
| Markdown WYSIWYG | ✅ | ❌ | ✅ | ❌ | ✅ |
| AI Agent | ✅ | ✅ | ❌ | ✅ | ❌ |
| Vault system | ✅ | ❌ | ✅ | ❌ | ❌ |
| Static publish | ✅ | ❌ | ❌ (plugin) | ❌ | ❌ |
| Native desktop | ✅ (macOS) | ✅ (mac) | ✅ (multi) | ✅ (multi) | ✅ (multi) |
| Bundle size | ~10MB | ~200MB | ~200MB | ~300MB | ~20MB |
| Open Source | ✅ | ✅ | ❌ | ✅ | ❌ |
