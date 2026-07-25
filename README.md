# Editor

Desktop markdown editor — Wails + Go + HTMX + CodeMirror 6.

**macOS 10+** | arm64 + x64

## Stack

| Layer | Teknologi |
|-------|-----------|
| Desktop | Wails v2 |
| Backend | Go (chi, goldmark, fsnotify) |
| Frontend | HTMX + Alpine.js |
| Editor | CodeMirror 6 |
| Preview | @docubook/mdx-content (React, esbuild standalone) |

## Struktur

```
frontend/
├── index.html             # HTMX + Alpine entry
├── src/
│   ├── main.js            # Alpine app + editor bridge
│   ├── editor.js           # CodeMirror 6 wrapper
│   └── style.css           # Zed theme
├── preview/
│   └── preview.tsx         # Preview bundle (esbuild)
├── build-preview.cjs       # esbuild config
├── public/preview.js       # Build output (10MB)
└── vite.config.js
internal/
├── server/router.go        # chi HTTP + HTMX handlers
├── vault/service.go        # Vault CRUD
└── markdown/parser.go      # Goldmark parser
build/
├── bin/editor.app           # Wails build output
└── darwin/Info.plist
.github/workflows/build.yml  # CI: amd64 + arm64
```

## Dev

```bash
cd frontend && npm install && cd ..
wails dev
```

## Build

```bash
cd frontend && npm run build && cd ..
wails build -skipbindings
```

CI: tag `v*` → 2 DMG (intel + apple silicon).
