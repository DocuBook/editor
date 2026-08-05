# Contributing to DocuBook

Thanks for your interest! This guide covers setting up a dev environment, the project layout, and the contribution workflow.

## Prerequisites

- **macOS** 12 (Monterey) or later
- **Node.js** >= 22
- **Bun** or npm
- **Rust** toolchain — pinned via `rust-toolchain.toml` (rustup installs it automatically)
- **Tauri v2 system dependencies** — see https://v2.tauri.app/start/prerequisites/
- **Docker** — only needed to build/test the web image (`docker build`); local server development needs no Docker

## Build from Source

### Desktop (Tauri)

```text
git clone https://github.com/DocuBook/editor.git
cd editor
npm install
npm run tauri dev        # dev mode with hot reload
npm run tauri build      # production build
```

#### Cross-compile

```text
# Intel Macs
rustup target add x86_64-apple-darwin
npm run tauri build -- --target x86_64-apple-darwin

# Apple Silicon
rustup target add aarch64-apple-darwin
npm run tauri build -- --target aarch64-apple-darwin
```

### Web server (self-host / Docker)

The web distribution is a standalone Rust server (`src-tauri-server`) that serves the same frontend and reuses the desktop app's pure modules — no Tauri, no Docker required for local dev:

```text
npm run build                                  # frontend → dist/
cd src-tauri-server
DATA_DIR=./data WWW_DIR=../dist cargo run --release
# open http://localhost:8080 → setup wizard creates the admin account
```

Or build the full image (validated in CI on every PR):

```text
docker compose up --build
```

Runtime configuration (admin seeding, session TTL, open access, secure cookie) is documented in [`.env.example`](./.env.example).

## Project Structure

```text
src/
  main.tsx               Entry point (polyfills + ErrorBoundary)
  App.tsx                Root layout, auth gate, keyboard shortcuts, single git-status poller
  lib/
    ipc.ts               Runtime bridge — Tauri IPC on desktop, HTTP/SSE on web (single API)
  components/
    Editor.tsx           WYSIWYG + Markdown modes, AI transport (xl-ai ↔ Rust)
    Sidebar.tsx          Vault tree, search, CRUD, context menu
    StatusBar.tsx        Git branch indicator (consumes shared poll)
    GraphView.tsx        Note graph visualization
    SettingsModal.tsx    Settings (tabs: AI + Git; System is web-only)
    SystemSettings.tsx   Web-only: account, login toggle, session TTL, env display
    GitSettings.tsx      Git identity / remotes / init in-app
    SetupWizard.tsx      Web first-run: create the admin account (or "skip")
    Login.tsx            Web login gate (rate-limited, httpOnly session cookie)
    VaultPicker.tsx      Web vault picker (modal; replaces the native folder dialog)
    ShortcutsModal.tsx   Keyboard shortcuts reference
    ErrorBoundary.tsx    Root crash recovery screen
  stores/
    editor.ts            Tabs, file content, edited content, undo/redo state
    vault.ts             Vault state, tree, folder expansion, recent vaults
    aiSettings.ts        Provider/model/saved-providers (persisted) — API keys live only in keychain
    auth.ts              Web auth status (setup → login → ready), 401 handling
    gitStatus.ts         Shared git status (branch + porcelain) — one poller
  data/
    providers.ts         Auto-generated provider/model catalog (models.dev)
  hooks/
    useKeyboard.ts       Keyboard shortcut handling
    usePolling.ts        Interval polling
    useClickOutside.ts   Click-outside detection for menus
  utils/
    aiBlocks.ts          AI text → applyDocumentOperations (suggestions)
src-tauri/
  src/
    main.rs              Tauri entry point
    lib.rs               Tauri commands (vault, wiki, git, search, AI, keychain)
    keychain.rs          macOS Keychain access via `security` CLI
    agent/               AI agent config + SSRF-guarded base-URL validation
    vault/               File system vault (path-traversal-safe)
    wiki/                Wikilink index
    git/                 Git add-commit-push / clone / remotes / identity
    search/              Filename search
src-tauri-server/        Web distribution — standalone axum server (no Tauri)
  src/
    main.rs              HTTP server: /api/<cmd> dispatcher, SSE AI streaming,
                         auth middleware, static file serving (SPA fallback)
    auth.rs              Argon2id passwords, in-memory sessions, login rate limit
    config.rs            Config merge (env > /data/config.json > default)
    keys.rs              API-key store (keys.json, 0600)
Dockerfile               Multi-stage web image (node → rust musl → alpine)
docker-compose.yml       Web deployment (volume /data, env reference)
.env.example             All server environment variables
```

## Architecture Notes

- **Trust boundary:** the Rust backend (desktop `src-tauri` / web `src-tauri-server`) is trusted; the frontend is not. File paths are canonicalized against the vault root, AI base URLs are allowlisted (SSRF guard), and API keys never reach the frontend — the webview cannot read them.
- **Two runtimes, one frontend:** `src/lib/ipc.ts` abstracts Tauri IPC and HTTP/SSE behind one `invoke`/`listen` API, so components are runtime-agnostic. The web server reuses the desktop app's pure modules (`vault`, `wiki`, `git`, `search`, `agent`) via `#[path]` includes — never edit them in one place only.
- **Web auth:** first run creates an admin account (Argon2id); sessions are httpOnly cookies (rate-limited login). `DB_NO_AUTH=1` keeps open access (pre-web behavior). Env vars win over the Settings → System overrides.
- **API keys:** macOS Keychain on desktop; `keys.json` (0600) in `/data` on web. Both are resolved server-side in `ask_ai` — a frontend-supplied key is ignored.
- **Permissions (desktop):** if you add or remove a Tauri command, regenerate `src-tauri/permissions/default.toml` and `src-tauri/capabilities/default.json` in the same change (see the header comment in the permission file).
- **Versions:** `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` must stay in sync — CI enforces it. `src-tauri-server/Cargo.toml` is versioned independently.

## Workflow

1. Fork the repo and create a branch: `git checkout -b fix/your-change`
2. Make your change. Keep commits focused.
3. Run checks locally:
   - `npx tsc -b`
   - `npx vitest run`
   - `npm run build`
   - `cd src-tauri && cargo test`
   - `cd src-tauri-server && cargo test`
4. Open a PR against `master` using the PR template.

**CI runs the full artifact matrix on every PR** (not just on release): frontend build, desktop DMG, web server binary, and a full `docker build` of the web image (which also reports the image size). If your change touches the Dockerfile, the Rust modules, or the frontend, the PR build is the fastest way to catch breakage.

The pre-commit hook runs `lint-staged` (oxlint on staged files); the pre-push hook runs the full type check + Rust + frontend tests.

## Security

Found a vulnerability? See [SECURITY.md](./SECURITY.md) — report privately, not as a public issue.
