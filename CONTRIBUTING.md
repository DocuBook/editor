# Contributing to DocuBook

Thanks for your interest! This guide covers setting up a dev environment, the project layout, and the contribution workflow.

## Prerequisites

- **macOS** 12 (Monterey) or later — desktop development only
- **Node.js** >= 22
- **npm**
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

Only stable root responsibilities are documented here; inspect each directory for current implementation details.

```text
editor/
├── frontend/      Shared React UI for desktop and web
├── src-tauri/     Tauri desktop runtime, native commands, and permissions
├── server/        Axum web runtime, HTTP API, auth, and persistence
├── test/          Frontend unit tests, shared fixtures, and web E2E harness
├── public/        Static assets copied into frontend builds
├── dist/          Generated frontend build output
└── .github/       CI, release, and repository automation
```

## Architecture Notes

- **Trust boundary:** the Rust backend (desktop `src-tauri` / web `server`) is trusted; the frontend is not. File paths are canonicalized against the vault root, and AI base URLs pass SSRF validation before requests are sent.
- **Two runtimes, one frontend:** `frontend/lib/ipc.ts` abstracts Tauri IPC and HTTP/SSE behind one `invoke`/`listen` API, so components are runtime-agnostic. The web server reuses the desktop app's pure modules (`vault`, `wiki`, `git`, `search`, `agent`) via `#[path]` includes — never edit them in one place only.
- **Web auth:** first run creates an admin account (Argon2id); sessions are httpOnly cookies (rate-limited login) persisted in `sessions.json` (SHA-256 hashed tokens — they survive server restarts, so redeploys don't log users out). `DB_NO_AUTH=1` keeps open access (pre-web behavior); the setup wizard's "Skip — keep open access" is consent-gated (acknowledgement checkbox). Env vars win over the Settings → System overrides.
- **API keys:** macOS Keychain on desktop; `keys.json` (0600) in `/data` on web, optionally AES-256-GCM encrypted at rest via `DB_KEYS_PASSPHRASE` (Argon2id-derived key). Stored keys are not returned to or persisted by the frontend; `ask_ai` resolves them backend-side and ignores a key supplied in that request.
- **Permissions (desktop):** if you add or remove a Tauri command, regenerate `src-tauri/permissions/default.toml` and `src-tauri/capabilities/default.json` in the same change (see the header comment in the permission file).
- **Versions:** `package.json`, `src-tauri/Cargo.toml`, `server/Cargo.toml`, and `src-tauri/tauri.conf.json` must stay in sync — CI enforces this across manifests and lockfiles.

## Workflow

1. Fork the repo and create a branch: `git checkout -b fix/your-change`
2. Make your change. Keep commits focused.
3. Run checks locally:
   - `npx tsc -b`
   - `npm test`
   - `npm run build`
   - `cd src-tauri && cargo test`
   - `cd server && cargo test`
   - Build the web server + frontend, then the Playwright suites
     (run logs land in `test/artifacts/` — server stdout/stderr,
     browser console, and per-run results):
     `cargo build --manifest-path server/Cargo.toml && npm run build`
     `npm run test:e2e` # all suites, chromium (default)
     `BROWSER=webkit npm run test:e2e` # webkit — CI only (macos-15 runner)

     Browser coverage:
     - Local macOS 12 runs Chromium through the installed Playwright browser
       or the system Chrome fallback; WebKit is CI-only.
     - CI runs Rust and desktop checks on macOS 14, then the Chromium/WebKit
       E2E matrix on macOS 15 as required by the pinned Playwright build.
4. Open a PR against `master` using the PR template.

### Commit conventions (enforced by the commit-msg hook)

```
<type>(<scope>): <subject>
```

**DRY mapping — the commit subject IS the changelog line.** Each type maps 1:1 to a CHANGELOG category; a release section is assembled by grouping the merged PR subjects by type (no rewriting):

| Type       | CHANGELOG category   | Usage                                     |
| ---------- | -------------------- | ----------------------------------------- |
| `feat`     | 🚀 Features          | new feature                               |
| `fix`      | 🐛 Bug Fixes         | bug fix                                   |
| `security` | 🛡️ Security          | security hardening / audit                |
| `perf`     | ⚡ Performance       | performance optimization                  |
| `refactor` | 🔄 Refactor          | structural change without behavior change |
| `docs`     | 📚 Documentation     | documentation (README, CONTRIBUTING)      |
| `test`     | 🧪 Testing & CI      | test suite / test tooling                 |
| `ci`       | 🔧 CI                | CI / pipeline                             |
| `chore`    | 🔄 Version / Hygiene | maintenance (release, deps)               |

- **Scope** is optional and may contain lowercase letters, digits, dots, or hyphens: `fix(docker):`, `ci(release):`, `feat(theme):`
- **Subject** should be concise, imperative, and lowercase because it becomes the changelog line
- **Merge commits** are exempt from the hook
- **Release changelog = the merged PR subjects grouped by type** — each subject lands verbatim under its category in `CHANGELOG.md`; the section is assembled from commits, not rewritten (DRY)
- The hook rejects other formats and lists the allowed types — no commitlint needed

**PR CI validates both runtimes:** lint, type checks, frontend and Rust tests, Linux server tests, browser E2E, desktop DMGs, and multi-platform Docker builds. Heavy E2E, desktop, and Docker jobs may require environment approval. Release artifacts are published only from version tags.

The pre-commit hook runs `lint-staged` (oxlint on staged TypeScript files). The pre-push hook syncs lockfiles from manifests (npm `--package-lock-only` + root-version-only `Cargo.lock` updates), **fails if a lock changed**, then runs the type check, desktop Rust tests, and frontend tests. Run `cargo test --manifest-path server/Cargo.toml` separately before pushing server changes.

## Release workflow (custom — no semantic-release/changeset)

```
PR (conventional commit) → merge to master → CI audit → tag on master → CI publishes
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
