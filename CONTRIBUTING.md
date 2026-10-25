# Contributing to DocuBook

Thanks for your interest! This guide covers setting up a dev environment, the project layout, and the contribution workflow.

## Prerequisites

- **macOS** — desktop development only. CI uses macos-15 for lint/test/build/E2E (macos-14 runners retire on 2026-11-02; the pinned Playwright WebKit build also needs macOS 15+). The app itself targets macOS 12.3+ (WKWebView Safari 15.4) — the build job pins and verifies that deployment target, and the compat lints hold the frontend to `.browserslistrc`
- **Node.js** 22.22.1 or newer — CI pins `22.23.4` (the newest dependency floor is `lint-staged` 17 at `>=22.22.1`; ESLint 10, pulled in by `eslint-plugin-compat`, needs `^22.13.0`); `package.json` declares no `engines` range, so this is a CI contract, not an enforced constraint. The Dockerfile's `node:22-alpine` floats on the same major
- **npm**
- **Rust** toolchain — pinned via `rust-toolchain.toml` (rustup installs it automatically; includes `clippy` and `rustfmt`)
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

The web distribution is a standalone Rust server (`server`) that serves the same frontend and shares the desktop app's pure modules through the `core` crate (`docubook-core`) — no Tauri, no Docker required for local dev:

```text
npm run build                                  # frontend → dist/
cd server
DATA_DIR=./data WWW_DIR=../dist cargo run --release
# open http://localhost:8080 → setup wizard creates the admin account
```

Or build the full image (validated in CI on every PR — amd64 only on PRs; arm64
plus multi-arch publish runs on tags):

```text
docker compose up --build
```

Runtime configuration (admin seeding, setup protection, session TTL, secure cookie) is documented in [`.env.example`](./.env.example).

rust-ai's only context tools are the built-in `web_search` / `web_fetch` (`core/rust-ai/web/`), off until enabled in Settings → AI → Web Tools; `DOCUBOOK_SEARXNG_URL` / `DOCUBOOK_TAVILY_API_KEY` pin the search provider on the server. `web_fetch` must stay behind the SSRF guard (`web/net_guard.rs`) and the per-turn URL-provenance ledger (`web/ledger.rs`). Provider-native search must fail closed unless explicitly supported by provider capability metadata.

## Project Structure

Only stable root responsibilities are documented here; inspect each directory for current implementation details.

```text
editor/
├── frontend/      Shared React UI for desktop and web
├── core/          Shared pure-Rust engine (vault, wiki, git, search, agent, AI)
├── src-tauri/     Tauri desktop runtime, native commands, and permissions
├── server/        Axum web runtime, HTTP API, auth, and persistence
├── test/          Frontend unit tests, shared fixtures, and web E2E harness
├── public/        Static assets copied into frontend builds
├── dist/          Generated frontend build output
├── data/          Local web-server data dir (gitignored; DATA_DIR default)
└── .github/       CI, release, and repository automation
```

## Architecture Notes

- **Trust boundary:** the Rust backend (desktop `src-tauri` / web `server`) is trusted; the frontend is not. File paths are canonicalized against the vault root, and AI base URLs pass SSRF validation before requests are sent.
- **Two runtimes, one frontend:** `frontend/lib/ipc.ts` abstracts Tauri IPC and HTTP/SSE behind one `invoke`/`listen` API, so components are runtime-agnostic. Both runtimes share the pure modules (`vault`, `wiki`, `git`, `search`, `agent`, `rust-ai`, `markdown`) through the `core` crate (`docubook-core`): the desktop app re-exports them, the web server depends on the crate by path — never edit them in one place only. `node test/check-docker-paths.mjs` (CI lint job) fails if a server source reaches back into `src-tauri` via a `#[path]` include, or if the Dockerfile stops packaging `core/`.
- **Web auth:** first run requires an admin account (Argon2id); setup cannot be skipped and login remains required. Sessions are httpOnly cookies (rate-limited login) persisted in `sessions.json` (SHA-256 hashed tokens — they survive server restarts, so redeploys don't log users out). Account creation requires a setup token: `DB_SETUP_TOKEN` when set, otherwise a one-time token printed to the server log at first boot. Env vars win over Settings → System overrides.
- **API keys:** macOS Keychain on desktop; `keys.json` (0600) in `/data` on web, optionally AES-256-GCM encrypted at rest via `DB_KEYS_PASSPHRASE` (Argon2id-derived key). Stored keys are not returned to or persisted by the frontend; `ask_ai` resolves them backend-side and ignores a key supplied in that request.
- **Permissions (desktop) and web IPC:** `generate_handler!` in `src-tauri/lib.rs` is the single source of truth for the command surface. Adding or removing a command means updating `src-tauri/capabilities/default.json`, `src-tauri/permissions/default.toml`, and the `server/handlers.rs` dispatch in the same change; `node test/check-acl.mjs` (CI lint job) fails when any of them drifts, including a stale desktop-only/web-only exception.
- **Versions:** `package.json`, `src-tauri/Cargo.toml`, `server/Cargo.toml`, `core/Cargo.toml`, and `src-tauri/tauri.conf.json` must stay in sync — CI enforces this across manifests and lockfiles. All five are bumped automatically by `release-please`; never edit them by hand (see [Release workflow](#release-workflow-automated--release-please)).

## Workflow

1. Fork the repo and create a branch: `git checkout -b fix/your-change`
2. Make your change. Keep commits focused, and sign off every commit (`git commit -s`) — see [Contribution licensing](#contribution-licensing).
3. Run checks locally. The pre-push hook only enforces the lockfile sync and `npx tsc -b` — the remaining checks, including `npm test`, `cd core && cargo test`, `cd src-tauri && cargo test`, and `cd server && cargo test`, are not part of the hook and must be run manually:
   - `npx oxlint frontend/ test/__fixtures__/`
   - `npx tsc -b`
   - `node test/check-acl.mjs`
   - `node test/check-docker-paths.mjs`
   - `npm test`
   - `npm run build`
   - `npm run lint:compat` — engine-compat guard on the built `dist/` (needs `npm run build` first)
   - `cd core && cargo test`
   - `cd src-tauri && cargo test`
   - `cd server && cargo test`
   - `cargo clippy --manifest-path core/Cargo.toml -- -D warnings`
   - `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
   - Build the web server + frontend, then the Playwright suites
     (run logs land in `test/artifacts/` — server stdout/stderr,
     browser console, and per-run results):
     `cargo build --manifest-path server/Cargo.toml && npm run build`
     `npm run test:e2e` # all suites, chromium (default)
     `BROWSER=webkit npm run test:e2e` # webkit — CI only (macos-15 runner)

      `test/run-all.mjs` discovers every `test/*.mjs` E2E suite automatically;
      scripts, runner coverage, and this guide therefore stay aligned. Any suite
      failing fails the run. `test/check-*.mjs` are repository guards, not E2E suites.

      The mobile shell suite keeps runtime geometry checks and shipped artifact
      pins for the dvh gate and viewport meta key. It does not pin negative CSS
      strings or the composer rail's implementation-specific height.

     Browser coverage:
     - Local macOS runs Chromium through the installed Playwright browser
       or the system Chrome fallback; WebKit is CI-only.
     - CI runs Rust, lint, and security checks on macOS 15 / Ubuntu 22.04,
       then the Chromium/WebKit E2E matrix on macOS 15 as required by the
       pinned Playwright build.
     - That WebKit is the newest engine, not the oldest one we ship to:
       desktop runs on the system WKWebView, down to Safari 15.4 on
       macOS 12.3. The oldest engines are covered statically instead —
       `compat/compat` in `.oxlintrc.json` (our source) and
       `npm run lint:compat` (the built bundle, dependencies and Tailwind
       output included), both against `.browserslistrc`. Two blind spots:
       neither sees an unsupported value of a supported CSS property (e.g.
       `overflow: clip`), so keep the `@supports` fallbacks in
       `frontend/index.css`; and the JS rule only knows the APIs in its
       bundled snapshot, so newer ones (e.g. `Object.groupBy`, `URL.canParse`,
       `AbortSignal.timeout`) pass unflagged and need a manual caniuse check.
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

**PR CI validates both runtimes:** lint (oxlint over `frontend/`,
`test/__fixtures__/`), type checks, ACL and Docker-path guards, version
consistency, frontend and Rust tests, Rust clippy, `cargo audit`/`npm audit`,
Linux server tests, Chromium/WebKit browser E2E, desktop DMGs, and Docker image
builds. Heavy E2E, desktop, and Docker jobs may require environment approval.
Release artifacts are published only from version tags.

The pre-commit hook runs `lint-staged` (oxlint on staged TypeScript files). The pre-push hook syncs lockfiles from manifests (npm `--package-lock-only` + root-version-only `Cargo.lock` updates across the three crates), **fails if a lock changed**, then runs the type check (`npx tsc -b`). It does **not** run any tests — desktop, shared-engine (`core`), and server Rust tests plus frontend tests must be run manually before pushing (see [Workflow](#workflow)); PR CI runs them regardless.

## Release workflow (automated — release-please)

```
PR (conventional commit) → merge to master → release-please opens/updates
  chore(release): vX.Y.Z → CI audit → merge → tag + CHANGELOG → CI publishes
```

Releases are driven by [`release-please`](https://github.com/googleapis/release-please)
(`.github/workflows/release-please.yml`, config in `release-please-config.json`,
state in `.release-please-manifest.json`). Nobody bumps a manifest or edits
`CHANGELOG.md` by hand any more.

1. **PRs merge to `master`** (squash). PR CI covers the full artifact matrix.
2. **`release-please` opens or updates one release PR**, titled
   `chore(release): vX.Y.Z — DocuBook`. The PR bumps the five manifests and
   prepends a `## vX.Y.Z — YYYY-MM-DD` section to `CHANGELOG.md`, grouping
   entries by commit type.

   It rewrites the release branch on every push to `master` — the workflow
   explicitly rebases the branch on the new `master` head and force-updates the
   ref (not a merge), so the PR never needs manual rebasing. `always-update` in
   `release-please-config.json` makes release-please rebuild the branch when it
   has a release candidate; the workflow rebase also covers pushes containing
   only hidden `docs`, `test`, or `chore` commits. `always-update` is a
   root-level manifest option — it is not read from `packages`.

3. **The same workflow syncs the lockfiles** onto the release-PR branch. It
   bumps `package-lock.json` and the two consumer `Cargo.lock` root versions,
   and rewrites the generated changelog heading to this repo's format. This is
   the CI-side twin of the `pre-push` hook — release-please pushes manifests
   only, and the version-consistency gate below would otherwise fail the PR.
   The job runs after *every* release-please run and resolves the branch by the
   `autorelease: pending` label, because the action only reports a branch in its
   `pr` output when it *opened* a PR, not when it rebased one.
4. **Audit gate — enforced by CI.** The version-consistency check in `ci.yml`
   fails the build if any of the **five manifests + three locks** drift, or if
   `CHANGELOG.md` is missing the section for the current version. Master must be
   green before tagging.
5. **Merging the release PR is the release.** release-please tags `vX.Y.Z` on
   `master`, which triggers CI publish (desktop DMG + multi-platform Docker
   image). No manual `git tag` step exists.

**What release-please does and does not touch:**

| File | Bumped by |
| --- | --- |
| `package.json` | release-please (release type `node`) |
| `src-tauri/Cargo.toml` | release-please (`extra-files`, toml) |
| `server/Cargo.toml` | release-please (`extra-files`, toml) |
| `core/Cargo.toml` | release-please (`extra-files`, toml) |
| `src-tauri/tauri.conf.json` | release-please (`extra-files`, json) |
| `package-lock.json`, all three `Cargo.lock` | the `sync-lockfiles` job |

The changelog heading format is deliberately CI-side: release-please emits
`## X.Y.Z (YYYY-MM-DD)` — or, for the `github` changelog dialect this repo gets,
`## [X.Y.Z](compare-url) (YYYY-MM-DD)` — and the `sync-lockfiles` job rewrites
either to `## vX.Y.Z — YYYY-MM-DD` so every section in the file reads the same.
The heading rewrite fails loudly if it finds no heading for the current version,
so a release-please format change surfaces in CI instead of shipping an
un-normalised changelog that the gate below then rejects.

**Version bumps are SemVer, decided by the highest-ranked commit type in the
release.** `feat` → minor, a breaking change (`!` or a `BREAKING CHANGE:`
footer) → major, everything else → patch. While the major is `0`,
`bump-minor-pre-major` (set in `release-please-config.json`) holds a breaking
change at a **minor** bump, so `0.1.8` → `0.2.0` rather than `1.0.0`;
`1.0.0` is therefore a deliberate step, not a side effect (see **Versioning** in
`CHANGELOG.md`). `bump-patch-for-minor-pre-major` is deliberately **not** set:
enabling it would fold a `feat` into a patch release, so features would stop
advancing the minor version.

**Rules:**

- **Never bump a version by hand** — not in a feature PR, not in a release
  commit. A manual bump desynchronises the manifest from
  `.release-please-manifest.json` and the next release PR will be wrong.
- **Never edit `CHANGELOG.md`'s current-version section by hand.** Commits after
  a release PR is opened are folded into it automatically on the next push.
- **Tags are immutable** — never force-move a released tag. A fix after release
  means a new version, then the full flow again.
- **Tags land on `master` only.**
- Docker image: immutable version tags with the `v` prefix (`:v0.1.0-next`);
  stable tags also move `:latest`, while prerelease tags do not.
- **Prerelease builds:** a change needing field validation before a stable
  release is cut with `versioning: prerelease` + `prerelease-type` rather than
  by hand (see **Versioning** in `CHANGELOG.md`).
- **Reaching `1.0.0` is manual.** A breaking change will not get you there while
  the major is `0`. Put `Release-As: 1.0.0` in the release commit's footer (or
  set `"release-as"` in the config for one run), then **remove it** — `release-as`
  is sticky and would pin every later release.
  `node test/check-release-config.mjs` (CI lint job) fails if `release-as` is
  still set to a version that has already shipped, if `bootstrap-sha` does not
  resolve, or if `changelog-sections` drifts from the types the `commit-msg` hook
  allows. Run it locally after editing either release config file.

> A push made with `GITHUB_TOKEN` does not trigger other workflows, so the
> `sync-lockfiles` commit does not re-run `ci.yml` on the release PR. Checks run
> when the PR is opened and after the merge. To have them run on every push to
> the release PR, set a PAT or GitHub App token as `RELEASE_PLEASE_TOKEN` and
> use it in both the action and the checkout.

## Contribution licensing

Every commit must carry a `Signed-off-by` line certifying the [Developer Certificate of Origin 1.1](https://developercertificate.org/) (`git commit -s`). You keep your copyright; the sign-off certifies you have the right to submit the work.

By signing off, you also agree that:

- Your contribution is licensed to the project and its users under **AGPL-3.0** (inbound = outbound).
- You grant the maintainer a perpetual, worldwide, non-exclusive, royalty-free right to use, reproduce, modify, distribute, and **relicense** your contribution under any license, including commercial terms.

The second point is what keeps the commercial licensing option available: it lets the maintainer offer a closed commercial license covering the whole codebase. If you cannot agree to it, open an issue before writing code — the change cannot be merged.

## Security

Found a vulnerability? See [SECURITY.md](./SECURITY.md) — report privately, not as a public issue.
