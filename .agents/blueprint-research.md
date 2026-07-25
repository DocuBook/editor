# Blueprint Research — Editor: Zed + Obsidian + DocuBook

## Ringkasan Riset

**Konsep:** Editor desktop native yang menggabungkan:
- **Zed** — UI minimal, performa tinggi, AI agent
- **Obsidian** — Vault-based markdown management, wikilinks, backlinks, graph
- **DocuBook** — `@docubook/mdx-content` untuk preview, `docu.json` konfigurasi project, CI build/deploy

**Tech Stack:**
- Frontend: HTMX + Alpine.js + CodeMirror 6 + Tailwind v4
- Backend: Go (chi, goldmark, fsnotify, bleve)
- Desktop: Wails v2 (~10MB, macOS 10+, arm64 + x64)
- Preview: `preview.js` bundle — React + `@docubook/mdx-content` (standalone JS)

**Arsitektur:**
```
EDITOR (local)                        CLOUD (CI)
├─ Vault (markdown files)             Git push → flame build
├─ docu.json config                   → static HTML
├─ Git push → trigger CI              → deploy (Vercel/dll)
└─ AI agent (SSE streaming)
```

**Vault Modes:**
1. Pribadi (Obsidian-like) — tanpa docu.json, tanpa git push
2. Project (DocuBook) — ada docu.json + git push → CI build
3. Hybrid — multi-vault, campuran

**Vault Components (prioritas):**
| P0 | P1 | P2 |
|----|----|----|
| File tree (HTMX) | Wiki links [[ | File watcher |
| CodeMirror 6 | Backlinks | Graph view (D3.js) |
| Preview (mdx-content) | Tags | |
| | Full-text search | |

**Key Decisions:**
1. Wails (Go) > Tauri (Rust) — Go lebih familiar, bundle tetap ~10MB
2. HTMX > SPA — 70% interaktivitas tanpa JS framework
3. Flame build di CI — git, base image, deps di cloud, bukan di editor
4. Preview via standalone React bundle — HTMX tetap murni, output = final
5. Editor hanya: nulis markdown, manage vault, AI assist, git push

**Ekosistem Existing:**
- docubook/ (@docubook/mdx-content, @docubook/flame) — layer preview & deploy
