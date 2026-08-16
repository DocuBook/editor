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

The web distribution is a standalone Rust server (`server`) that serves the same frontend and reuses the desktop app's pure modules — no Tauri, no Docker required for local dev:

```text
npm run build                                  # frontend → dist/
cd server
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
frontend/
  main.tsx               Entry point (Safari15 polyfills + ErrorBoundary)
  App.tsx                Root layout, auth gate, keyboard shortcuts, single git-status poller
  index.css              Tailwind v4 + design tokens (@theme dark palette, [data-theme=light]) + ProseMirror styles
  lib/
    ipc.ts               Runtime bridge — Tauri IPC on desktop, HTTP/SSE on web (single API)
  components/
    Editor.tsx           Main layout — routes the active file to the right view
                         (wysiwyg / image preview / plain text), keyboard shortcuts,
                         shared scroll container. The heavy pieces live in ./editor.
    editor/
      WysiwygEditor.tsx  BlockNote editor lifecycle: markdown load/sync, dirty tracking,
                         AI scroll-follow, wikilink hover/click hints, slash menu (math,
                         diagram, AI). Hosts the xl-ai extension.
      TabBar.tsx         Tab strip (auto-scroll), undo/redo, Editor/Code toggle,
                         Save (stage), Publish (commit+push), AI toggle
      WelcomeScreen.tsx  Launchpad when no vault is open (open/create/clone vault)
      linkToolbar.tsx    Link toolbar overrides — vault-relative links keep as-typed
                         URLs (no https:// forcing) + vault-note linker in one popover
      previews.tsx       Image inline preview + plain-text viewer + Markdown textarea
      setup.ts           Shared schema (heading 1-5, math, diagram) + [[wikilink]]
                         ProseMirror decoration/click handling
    Sidebar.tsx          Vault tree, search, CRUD, context menu, trash
    StatusBar.tsx        Git branch indicator (consumes shared poll)
    SettingsModal.tsx    Settings (tabs: AI, Appearance, Git; System is web-only)
    SystemSettings.tsx   Web-only: account, login toggle, session TTL, env display
    GitSettings.tsx      Git identity / remotes / init in-app
    SetupWizard.tsx      Web first-run: create the admin account (or "skip")
    Login.tsx            Web login gate (rate-limited, httpOnly session cookie)
    VaultPicker.tsx      Web vault picker (modal; replaces the native folder dialog)
    PasswordInput.tsx    Password field with show/hide toggle (login + change-password)
    AppearanceSettings.tsx  Theme picker (named themes: Midnight / Bright Surfaces)
    ShortcutsModal.tsx   Keyboard shortcuts reference
    OnboardingGuide.tsx  First-run guide for new vaults
    ErrorBoundary.tsx    Root crash recovery screen
  stores/
    editor.ts            Tabs, file content, edited content, undo/redo state
    vault.ts             Vault state, tree, folder expansion, recent vaults
    aiSettings.ts        Provider/model/saved-providers (persisted) + probeTools
                         (measured tool-call support per provider+model — set by
                         Save / model-switch auto-probe). API keys live only
                         backend-side (Keychain / keys.json, never the webview)
    auth.ts              Web auth status (setup → login → ready), 401 handling
    gitStatus.ts         Shared git status (branch + porcelain) — one poller
    theme.ts             Named theme store (data-theme + Tauri window + meta theme-color)
  data/
    providers.ts         Generated provider/model catalog — regenerate with
                         `node frontend/data/fetch-providers.mjs` (models.dev api.json)
    fetch-providers.mjs  Catalog generator script (fetches models.dev, writes providers.ts)
  hooks/
    useKeyboard.ts       Keyboard shortcut handling
    usePolling.ts        Interval polling
    useClickOutside.ts   Click-outside detection for menus
  utils/
    aiTransport.ts       xl-ai Chat transport — the ONLY window between xl-ai and Rust:
                         streaming SSE → ai-sdk parts, retry/gate loop, output routing
    aiBlocks.ts          Markdown → applyDocumentOperations; suffixOperationIds, semantic
                         validation, prompt builders (edit/vault-first/tool), doc context
    aiProbe.ts           Auto-probe tool-call support (test_connection), model-agnostic
                         text-only decision (custom endpoints measure-then-unlock)
    wikilink.ts          [[wikilink]] parse (findWikilinkAt) + resolve/open — one source
    mathMarkdown.ts      Math $/$$ → MathML pre-processor (BlockNote has no $ parsing)
    fileKind.ts          File extension contract — .md/.mdx wysiwyg, binary, text
    setupWizard.ts       Pure setup-wizard validation + payload builder (unit-testable)
    uuid.ts              Secure-context-safe UUID v4 (crypto.randomUUID with
                         getRandomValues/Math.random fallback — plain-HTTP/IP access)
    iteratorPolyfill.ts  Safari ES2023 iterator polyfills
    webkitCssStyleSheet.ts  Safari 15 CSSStyleSheet polyfill (mermaid needs it)
    webkitStructuredClone.ts Safari 15 structuredClone polyfill
test/
  lib.mjs                Shared CI-friendly harness: server + browser logs to
                         artifacts/, browser engine resolution (chromium/webkit,
                         system-Chrome fallback), pass/fail summary
  run-all.mjs            One entry point for all suites (npm run test:e2e;
                         BROWSER env picks the engine)
  web-smoke.mjs          Full-stack smoke: setup wizard → login → persistent
                         session across server restart
  trash.mjs              Trash UI: empty state (disabled) → restore → back in tree
  theme-check.mjs        Theme E2E (dark/light switch + picker in Settings)
  ai-debug.mjs           AI transport e2e (mock provider: Path A tools + Path B
                         text-only, selection + markdown)
  check-acl.mjs          ACL guard: every Tauri command has an allow-* entry
                         (run in CI lint)
  artifacts/             Run logs (server + browser console) + results (gitignored)

src-tauri/
  Cargo.toml             Desktop crate (bin docubook-desktop + lib docubook)
  tauri.conf.json        Window config (theme: Dark), CSP, bundle
  build.rs               tauri-build (capabilities/gen)
  main.rs                Tauri entry point
  lib.rs                 Tauri commands (vault, wiki, git, search, AI, keychain, markdown)
  markdown.rs            Shared markdown → safe-HTML (pulldown-cmark + ammonia)
  keychain.rs            macOS Keychain access via `security` CLI
  agent/                 AI agent config + SSRF-guarded base-URL validation
  vault/                 File system vault (path-traversal-safe)
  wiki/                  Wikilink index
  git/                   Git add-commit-push / clone / remotes / identity
  search/                Filename search
  capabilities/          Tauri 2 ACL (core:default, dialog, opener, allow-* app commands)
  permissions/           App command permission schemas (allow-*)
server/                  Web distribution — standalone axum crate (no Tauri)
  Cargo.toml             Bin docubook-server (musl-friendly, [[bin]] path = main.rs)
  main.rs                HTTP server: /api/<cmd> dispatcher, SSE AI streaming,
                         auth middleware, static file serving (SPA fallback)
  auth.rs                Argon2id passwords, persistent sessions (sessions.json,
                         SHA-256 hashed tokens, survive restarts), login rate limit
  config.rs              Config merge (env > /data/config.json > default)
  keys.rs                API-key store (keys.json, 0600; optional AES-256-GCM
                         encryption at rest via DB_KEYS_PASSPHRASE, Argon2id KDF)
dist/                    Frontend build output (gitignored; served by server + Tauri)
public/                  Static assets (appicon.png)
Dockerfile               Multi-stage web image (node → rust musl → alpine)
docker-compose.yml       Web deployment (volume /data, env reference)
docker-entrypoint.sh     Container entrypoint (data-dir self-heal + boot diagnostics)
rust-toolchain.toml      Pinned Rust toolchain (build reproducibility, REL-2)
.env.example             All server environment variables
```

## Architecture Notes

- **Trust boundary:** the Rust backend (desktop `src-tauri` / web `server`) is trusted; the frontend is not. File paths are canonicalized against the vault root, AI base URLs are allowlisted (SSRF guard), and API keys never reach the frontend — the webview cannot read them.
- **Two runtimes, one frontend:** `frontend/lib/ipc.ts` abstracts Tauri IPC and HTTP/SSE behind one `invoke`/`listen` API, so components are runtime-agnostic. The web server reuses the desktop app's pure modules (`vault`, `wiki`, `git`, `search`, `agent`) via `#[path]` includes — never edit them in one place only.
- **Web auth:** first run creates an admin account (Argon2id); sessions are httpOnly cookies (rate-limited login) persisted in `sessions.json` (SHA-256 hashed tokens — they survive server restarts, so redeploys don't log users out). `DB_NO_AUTH=1` keeps open access (pre-web behavior); the setup wizard's "Skip — keep open access" is consent-gated (acknowledgement checkbox). Env vars win over the Settings → System overrides.
- **API keys:** macOS Keychain on desktop; `keys.json` (0600) in `/data` on web, optionally AES-256-GCM encrypted at rest via the `DB_KEYS_PASSPHRASE` env var (Argon2id-derived key; plaintext files auto-migrate, encrypted files are never overwritten without the passphrase). Both are resolved server-side in `ask_ai` — a frontend-supplied key is ignored.
- **Permissions (desktop):** if you add or remove a Tauri command, regenerate `src-tauri/permissions/default.toml` and `src-tauri/capabilities/default.json` in the same change (see the header comment in the permission file).
- **Versions:** `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` must stay in sync — CI enforces it. `server/Cargo.toml` is versioned independently.

## Workflow

1. Fork the repo and create a branch: `git checkout -b fix/your-change`
2. Make your change. Keep commits focused.
3. Run checks locally:
   - `npx tsc -b`
   - `npx vitest run`
   - `npm run build`
   - `cd src-tauri && cargo test`
   - `cd server && cargo test`
   - Build the web server + frontend, then the Playwright suites
     (run logs land in `test/artifacts/` — server stdout/stderr,
     browser console, and per-run results):
     `cargo build --manifest-path server/Cargo.toml && npm run build`
     `npm run test:e2e`   # all suites, chromium (default)
     `BROWSER=webkit npm run test:e2e`   # webkit — CI only (macos-15 runner)

     Note — environment matrix (three macOS versions, no ambiguity):
     - macOS 12 (dev machine) — the MINIMUM supported OS, validated by the
       developer running the e2e smoke suites on their own machine. Newest
       Playwright browser builds target newer macOS, so local runs use the
       system Chrome fallback for chromium; webkit cannot run on macOS 12 —
       it is CI-only.
     - macOS 14+ (CI) — the SUPERSET check: the full e2e matrix (chromium AND
       webkit) runs ONLY in CI, with the latest Playwright version pinned and
       kept current (a stale pin risks regressing the browser protocol
       contract). The e2e job itself runs on the macOS 15 runner because the
       standard Playwright WebKit build (1.62+) needs macOS 15+; on older
       runners it falls back to an older WebKit that rejects the driver's
       PushAPIEnabled context setting. A passing CI run is a superset check,
       not a claim about macOS 12 internals; the minimum-OS claim rests on
       the dev machine.
4. Open a PR against `master` using the PR template.

### Commit conventions (enforced by the commit-msg hook)

```
<type>(<scope>): <subject>
```

**DRY mapping — the commit subject IS the changelog line.** Each type maps 1:1 to a CHANGELOG category; a release section is assembled by grouping the merged PR subjects by type (no rewriting):

| Type | CHANGELOG category | Usage |
|------|--------------------|-------|
| `feat` | 🚀 Features | new feature |
| `fix` | 🐛 Bug Fixes | bug fix |
| `security` | 🛡️ Security | security hardening / audit |
| `perf` | ⚡ Performance | performance optimization |
| `refactor` | 🔄 Refactor | structural change without behavior change |
| `docs` | 📚 Documentation | documentation (README, CONTRIBUTING) |
| `test` | 🧪 Testing & CI | test suite / test tooling |
| `ci` | 🔧 CI | CI / pipeline |
| `chore` | 🔄 Version / Hygiene | maintenance (release, deps) |

- **Scope** is optional, kebab-case: `fix(docker):`, `ci(release):`, `feat(theme):` — when it adds signal, keep it as a prefix on the changelog bullet (`feat(theme):` → "theme: …")
- **Subject**: concise, imperative, lowercase — write it as the changelog line it will become
- **PR merge commits** (squash) are exempt from the hook
- **Release changelog = the merged PR subjects grouped by type** — each subject lands verbatim under its category in `CHANGELOG.md`; the section is assembled from commits, not rewritten (DRY)
- The hook rejects other formats and lists the allowed types — no commitlint needed

**CI runs the full artifact matrix on every PR** (not just on release): frontend build, desktop DMG, web server binary, and a full `docker build` of the web image (which also reports the image size). If your change touches the Dockerfile, the Rust modules, or the frontend, the PR build is the fastest way to catch breakage.

The pre-commit hook runs `lint-staged` (oxlint on staged files); the pre-push hook syncs lockfiles from manifests (npm `--package-lock-only` + a root-version-only `Cargo.lock` sync — no dep churn, no hand-editing `*.lock`), **fails the push if a lock changed** (commit the sync and re-push), then runs the full type check + Rust + frontend tests.

## Release workflow (custom — no semantic-release/changeset)

```
PR (feat:/fix:/perf:/chore:) → merge to master → CI AUDIT → tag on master → CI publishes
```

1. **PRs merge to `master`** (squash). PR CI covers the full artifact matrix.
2. **Version bump + changelog** in the release commit: bump the **manifests only** (`package.json`, `src-tauri/Cargo.toml`, `server/Cargo.toml`, `src-tauri/tauri.conf.json`) plus a `## vX.Y.Z — YYYY-MM-DD` section in `CHANGELOG.md` (custom format, grouped sections). **Never bump `*.lock` by hand** — the pre-push hook syncs `package-lock.json` (npm `--package-lock-only`) and both `Cargo.lock` files (root version only, deps untouched) from the manifests, and **rejects the push** if a lock had to change so the sync lands in its own commit before re-pushing.
3. **Audit gate — enforced by CI, not a local script.** The version-consistency check in `ci.yml` (runs on master after merge) fails the build if: any of the **four manifests + three locks** drift, or `CHANGELOG.md` is missing the `## vX.Y.Z —` section for the current version. Master must be green before tagging.
4. **Tag on master — immutable, annotated:**
   ```sh
   git tag -a vX.Y.Z -m "vX.Y.Z — <summary>"
   git push origin master
   git push origin vX.Y.Z
   ```
   Tag push triggers CI publish (desktop DMG + multi-platform Docker image).

**Rules:**
- **Tags are immutable** — never force-move a released tag. A fix after release means a new version (bump the pre-release number, e.g. `beta.3`), then the full flow again.
- Tag only on `master` (a tag on a branch survives squash-merge poorly: the tagged commit is not reachable from master).
- Version bumps go together in the release commit — never bump in a feature PR.
- Docker image: immutable version tags (`:0.1.0-beta.2`) + movable `:latest`.

## Security

Found a vulnerability? See [SECURITY.md](./SECURITY.md) — report privately, not as a public issue.
