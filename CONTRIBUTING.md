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
editor/
├── frontend/                         UI — single runtime, Tauri or web
│   ├── main.tsx                      Entry (Safari polyfills + ErrorBoundary)
│   ├── App.tsx                       Root layout, auth gate, shortcuts, git poller
│   ├── index.css                     Tailwind v4 + design tokens
│   ├── lib/ipc.ts                    Runtime bridge (Tauri IPC ↔ HTTP/SSE)
│   ├── data/providers.ts             Manual 4-endpoint catalog (model list runtime via /models)
│   ├── components/
│   │   ├── Editor.tsx                Layout/routing per file kind
│   │   ├── editor/                   WYSIWYG internals (block editor)
│   │   │   ├── WysiwygEditor.tsx     BlockNote lifecycle + xl-ai host
│   │   │   ├── TabBar.tsx            Tabs, undo/redo, save/publish, AI toggle
│   │   │   ├── linkToolbar.tsx       Link toolbar (as-typed URLs) + note linker
│   │   │   ├── previews.tsx          Image / plain-text / markdown viewers
│   │   │   ├── WelcomeScreen.tsx     Launchpad
│   │   │   └── setup.ts              Schema (math/diagram) + wikilink extension
│   │   ├── Sidebar.tsx               Vault tree, search, CRUD, backlinks, trash
│   │   ├── SettingsModal.tsx         AI / Appearance / Git / System tabs
│   │   └── (StatusBar, OnboardingGuide, SetupWizard, Login, …)
│   ├── stores/                       Zustand (editor, vault, aiSettings, auth, gitStatus, theme)
│   ├── hooks/                        useKeyboard, usePolling, useClickOutside
│   └── utils/                        aiTransport, aiBlocks, aiProbe, modelDiscovery,
│                                      mathMarkdown, wikilink, fileKind, polyfills
├── src-tauri/                        Desktop (Tauri v2) — monolithic lib.rs commands
│   ├── main.rs / lib.rs              Entry + all Tauri commands (vault/wiki/git/search/AI/keychain)
│   ├── markdown.rs                   Shared .md/.mdx extension contract
│   ├── keychain.rs                   macOS Keychain access
│   ├── vault/ wiki/ git/ search/ agent/
│   ├── capabilities/ permissions/    Tauri 2 ACL (allow-* per command)
├── server/                           Web distribution — axum, modules by responsibility
│   ├── main.rs                       Router glue + main
│   ├── handlers.rs                   Command dispatch (sync/sb/api)
│   ├── cmds.rs                       Vault/git/search/health + read-per-file grounding
│   ├── ai.rs / probe.rs              AI streaming / tool-call probe + list_models
│   ├── httpm.rs / auth_routes.rs     HTTP middleware / login/logout/setup_admin
│   ├── auth.rs / config.rs / keys.rs Persistence & auth building blocks
│   └── tests.rs                      API integration tests
├── test/                             CI e2e harness (lib.mjs, run-all.mjs, ai-debug.mjs…)
├── dist/  public/                    Build output / static assets
└── Dockerfile · docker-compose.yml · rust-toolchain.toml · .env.example
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
