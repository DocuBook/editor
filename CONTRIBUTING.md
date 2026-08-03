# Contributing to DocuBook

Thanks for your interest! This guide covers setting up a dev environment, the project layout, and the contribution workflow.

## Prerequisites

- **macOS** 12 (Monterey) or later
- **Node.js** >= 22
- **Bun** or npm
- **Rust** toolchain — pinned via `rust-toolchain.toml` (rustup installs it automatically)
- **Tauri v2 system dependencies** — see https://v2.tauri.app/start/prerequisites/

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

## Project Structure

```text
src/
  main.tsx               Entry point (polyfills + ErrorBoundary)
  App.tsx                Root layout, keyboard shortcuts, single git-status poller
  components/
    Editor.tsx           WYSIWYG + Markdown modes, AI transport (xl-ai ↔ Rust)
    Sidebar.tsx          Vault tree, search, CRUD, context menu
    StatusBar.tsx        Git branch indicator (consumes shared poll)
    GraphView.tsx        Note graph visualization
    SettingsModal.tsx    Settings (tabs: AI + Git) — keychain-backed, no key in webview
    GitSettings.tsx      Git identity / remotes / init in-app
    ShortcutsModal.tsx   Keyboard shortcuts reference
    ErrorBoundary.tsx    Root crash recovery screen
  stores/
    editor.ts            Tabs, file content, edited content, undo/redo state
    vault.ts             Vault state, tree, folder expansion, recent vaults
    aiSettings.ts        Provider/model/saved-providers (persisted) — API keys live only in keychain
    gitStatus.ts         Shared git status (branch + porcelain) — one poller
  data/
    providers.ts         Auto-generated provider/model catalog (models.dev)
  hooks/
    useKeyboard.ts       Keyboard shortcut handling
    usePolling.ts        Interval polling
    useClickOutside.ts   Click-outside detection for menus
  utils/
    aiBlocks.ts          AI text → applyDocumentOperations (suggestions)
src-tauri/src/
  main.rs                Tauri entry point
  lib.rs                 Tauri commands (vault, wiki, git, search, AI, keychain)
  keychain.rs            macOS Keychain access via `security` CLI
  agent/                 AI agent config + SSRF-guarded base-URL validation
  vault/                 File system vault (path-traversal-safe)
  wiki/                  Wikilink index
  git/                   Git add-commit-push / clone / remotes / identity
  search/                Filename search
```

## Architecture Notes

- **Trust boundary:** the Rust backend (`src-tauri`) is trusted; the webview is not. All file paths are canonicalized against the vault root, AI base URLs are allowlisted, API keys never leave the keychain (the webview cannot read them), and every Tauri command is scoped via the capabilities ACL.
- **Permissions:** if you add or remove a Tauri command, regenerate `src-tauri/permissions/default.toml` and `src-tauri/capabilities/default.json` in the same change (see the header comment in the permission file).
- **Versions:** `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` must stay in sync — CI enforces it.

## Workflow

1. Fork the repo and create a branch: `git checkout -b fix/your-change`
2. Make your change. Keep commits focused.
3. Run checks locally:
   - `npx tsc -b`
   - `npx vitest run`
   - `cd src-tauri && cargo test`
4. Open a PR against `master` using the PR template.

The pre-commit hook runs `lint-staged` (oxlint on staged files); the pre-push hook runs the full type check + Rust + frontend tests.

## Security

Found a vulnerability? See [SECURITY.md](./SECURITY.md) — report privately, not as a public issue.
