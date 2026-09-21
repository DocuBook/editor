# Changelog

## v0.1.0 — 2026-09-21

### First Stable Release

DocuBook's first stable release. The early-access series (`0.1.0-next`) is now
promoted to stable: the API and configuration formats are considered settled,
and the desktop and web builds share one frozen command surface.

#### 🚀 Features

- **Offline sync** — Edits made without a connection are queued durably and reconciled on reconnect through a content-version guard, so a stale write can no longer silently clobber newer content.
- **AI selection and tool-call probes** — The selected model and tool-call capability are probed once and persisted across browsers, so the AI panel no longer re-discovers them per session.

#### 🐛 Bug Fixes

- **Editors** — Restored tabs after reload, kept the shell viewport-bound so the AI chat stays on screen, and aligned the raw caret with its WYSIWYG block across mode switches.
- **Safari compatibility** — Restored Safari 15 rendering on macOS 12.
- **Mentions** — Dropped the recursive tagline from mention folder rows.
- **Vault** — Added an opening state while a vault loads and closed the gaps in the vault opening overlay.
- **AI** — Retried the original prompt when the first attempt fails.
- **Chrome** — Fixed settings dropdowns misplaced by the dialog `backdrop-filter`.
- **Docker** — Scoped the `/data` ownership repair to the mount type.
- **CI** — Kept the Docker smoke test green on non-root runners.

#### 🔄 Refactor

- Removed the unused `.tip` tooltip system.

#### 🔧 CI

- Silenced unactionable build warnings and corrected the stale polyfill note.

#### 🔄 Version / Hygiene

- Dependency bumps: `trash` 5.2.9, `esbuild` 0.28.2, `@tauri-apps/plugin-opener` 2.5.5, `oxlint` 1.83.0, `lint-staged` 17.5.1, Rust 1.97-alpine.
- Fixed the Coolify mount table and documented the stale container issue.
- Updated the README description.

---

## v0.1.0-next — 2026-09-18

### Early Access Release for testing

First public build, published for early access testing. Everything listed below is already present and usable, but features, APIs, and configuration formats are still **unstable** — expect breaking changes before a stable release.

#### 🚀 Features

- **Local vaults** — Open, create, or clone vaults as plain folders of Markdown files, with no proprietary format. Other text formats can be viewed; `.md` and `.mdx` use the WYSIWYG editor.
- **WYSIWYG block editing** — Headings, lists, quotes, code, math, and Mermaid diagram blocks, plus inline formatting. Open the block menu with `/`, and switch to raw Markdown mode to edit the source directly.
- **Reviewable AI** — Write, improve, summarize, translate, and fix text from an in-editor AI menu and a floating AI chat. Every suggestion streams in and can be accepted or rejected before it reaches the document.
- **Provider choice** — Built-in AI providers plus custom OpenAI-compatible endpoints, configured in **Settings → AI**, with keys stored backend-side.
- **Git publishing** — Configure identity and a remote, then stage, commit, push, and see the active branch without leaving the editor.
- **Fast navigation** — File search, expandable folders, backlinks, wikilinks, and keep-alive editor tabs that survive folder renames.
- **Desktop and web** — macOS desktop builds for Apple Silicon and Intel, and a Docker image for web with a required admin account on first run plus a `/api/health` check.
- **Theming** — Named themes with light- and dark-mode polish across the editor and app chrome.
- **Reliable autosave** — Editor changes are persisted at the app layer instead of depending on tab transitions.

---

## Versioning

This project follows **manual versioning** (not semver). Versions are:

- `0.1.0` — First stable release. API and configuration formats are settled.
- `0.x.0-next` — Later testing builds, when a change needs field validation before it lands in a stable release. Features, API, and configuration format may change.
- `0.x.y-beta` — Beta releases. API stabilization in progress.
- `1.x.0` — Future stable releases.

See [README.md](README.md) for documentation and setup guide.
