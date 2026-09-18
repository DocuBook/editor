# Changelog

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

- `0.1.x-next` — Early access testing builds. Features, API, and configuration format are UNSTABLE. Breaking changes expected at any time.
- `0.x.0-beta` — Future beta releases. API stabilization begins.
- `1.x.0` — Future stable releases.

See [README.md](README.md) for documentation and setup guide.
