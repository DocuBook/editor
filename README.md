<p align="center">
  <img alt="DocuBook" src="https://shieldcn.dev/header/graph.svg?title=DocuBook+Editor&amp;subtitle=The+markdown+editor+that+thinks+like+a+developer+%E2%80%94+Obsidian+vaults%2C+Notion+blocks%2C+Zed-speed+search%2C+and+Git+%E2%80%94+all+in+one.&amp;logo=lu%3AWandSparkles&amp;mode=dark" />
</p>

<p align="center">
  <a href="https://github.com/DocuBook/editor/releases"><img alt="release" src="https://shieldcn.dev/github/DocuBook/editor/release.svg?split=true" /></a>
  <a href="https://github.com/DocuBook/editor/actions"><img alt="CI" src="https://shieldcn.dev/github/DocuBook/editor/ci.svg?split=true" /></a>
</p>

> A **vault-based** editor that combines **WYSIWYG blocks**, an **AI assistant**, and **Git integration** — built with Tauri v2 (Rust) and BlockNoteJS (React).

---

## Install

Two distributions from the same codebase — **web (self-hosted Docker)** and **desktop (macOS)**. Pick one: vaults, the WYSIWYG editor, AI, and Git behave identically.

### Option A — Web (Docker, self-host)

> [!IMPORTANT]
> Docker **pulls a prebuilt image** — no build step on your side. The image is built in CI on every release (`ghcr.io/docubook/editor`) and contains the frontend **and** the server.

**Quick start:**

```bash
docker pull ghcr.io/docubook/editor
docker run -d --name docubook -p 8080:8080 \
  -v docubook:/data \
  ghcr.io/docubook/editor
# open http://localhost:8080 → setup wizard creates the admin account
```

**Docker Compose:**

```yaml
# docker-compose.yml
services:
  docubook:
    image: ghcr.io/docubook/editor
    ports:
      - "8080:8080"
    volumes:
      - docubook:/data          # vaults + keys.json + config.json (0600)
    environment:
      PORT: 8080
      # DB_SETUP_TOKEN: ""            # plain secret (not a JWT) — wizard asks for it
      # DB_ADMIN_EMAIL: admin@example.com    # set BOTH to skip the wizard
      # DB_ADMIN_PASSWORD: change-me-123
      # DB_NO_AUTH: "false"                  # "1" = open access without login
      # DB_SECURE_COOKIE: "1"                # enable behind HTTPS
    restart: unless-stopped

volumes:
  docubook:
```

> [!WARNING]
> **A persistent volume is REQUIRED — on every Docker host, without exception.**
> Containers are ephemeral: all data lives in `/data` (vaults, `config.json` with
> the admin account, `keys.json`). If nothing is mounted at `/data`, a redeploy,
> image pull, or container recreate **erases everything** — including your admin
> account — and the setup wizard reappears. This is **not Coolify-specific**:
> `docker run` without `-v`, Portainer, CapRover, Fly.io, Docker Desktop, or any
> hosting UI behave the same. Configure persistent storage **once**, with a
> **stable volume name** (e.g. `docubook`) and destination `/data`.
>
> The image self-heals `/data` ownership at every start (root entrypoint →
> `chown` → drop to the app user), so no manual `chown` is needed — but **the
> mount must exist**. Verify it survives redeploys:
>
> ```bash
> docker volume ls | grep docubook        # still ONE volume after several redeploys
> docker inspect <container> | grep -A2 '"/data"'
> #  "Type": "volume", "Source": "docubook"   ← correct, persists
> ```

**Environment configuration:**

All server variables are set via environment — the complete list is in [`.env.example`](./.env.example). They are read at **boot**, so set them before the first deploy; changing them means a restart/redeploy.

How you set them depends on your host — a `.env` file for `docker compose`, `-e` flags for `docker run`, or the environment panel of your Docker UI (e.g. **Coolify → Configuration → Environment Variables**, Portainer, CapRover — any panel works, the variables are the same).

| Variable | Default | Purpose |
|---|---|---|
| `DB_SETUP_TOKEN` | empty | First-run guard: a **plain secret string (not a JWT)**, e.g. `openssl rand -hex 32`. When set, the setup wizard asks for it before creating the admin — prevents anyone else from claiming the account first. Set it *before* the first deploy on public instances; leave empty for private/LAN |
| `DB_SECURE_COOKIE` | `false` | `1` = session cookie only over HTTPS — enable when behind TLS |
| `DB_NO_AUTH` | `false` | `1` = open access without login (pre-web behavior) |
| `DB_SESSION_TTL_HOURS` | `168` | Session lifetime before re-login |
| `DB_ADMIN_EMAIL` + `DB_ADMIN_PASSWORD` | — | Set **both** to skip the wizard entirely (headless provisioning) |

> [!NOTE]
> `DB_SETUP_TOKEN` is compared verbatim — it is **not** a JWT, has no expiry beyond the setup window, and the wizard never displays it (it only asks for it). Generate one with `openssl rand -hex 32` and keep it safe.

All environment variables are documented in [`.env.example`](./.env.example).

**Requirements (web):**

| Resource | Minimum | Recommended | Notes |
|---|---|---|---|
| CPU | 1 vCPU | 2 vCPU | lightweight axum server; git ops are occasional |
| Memory | **512 MB** | 1 GB | AI responses are streamed (not buffered) |
| Storage | 1 GB free | 10 GB | vault content lives in `/data` (volume) |
| Image size | ~20 MB compressed / ~35 MB unpacked | — | single stripped Rust binary + built frontend; verified in CI on every PR (`Report image size`) |

Works on any Docker-capable host: VPS (Hetzner, DigitalOcean, Linode, AWS Lightsail, Oracle Cloud…), Docker hosting (Coolify, Portainer, CapRover, Dokku, Yunohost…), NAS (Synology, Unraid), and ARM hosts — Raspberry Pi, Apple Silicon servers, ARM cloud instances (the image ships **`linux/amd64` + `linux/arm64`**, statically-linked musl binary).

**Deployment notes:**

- **Persistence**: everything lives in the `/data` volume (`vaults/`, `keys.json`, `config.json`). Back up that volume; the container is stateless and can be recreated any time.
- **HTTPS**: run behind a reverse proxy (Coolify/Traefik/Caddy/Nginx). Set `DB_SECURE_COOKIE=1` so the session cookie is only sent over HTTPS.
- **Upgrades**: `docker compose pull && docker compose up -d` — data is untouched. Sessions reset on restart (re-login required).
- **Health**: the image ships a Docker `HEALTHCHECK` against `/api/health` — Coolify/Portainer show container health automatically.

### Option B — Desktop (macOS)

Download the DMG for your Mac from the [Releases](https://github.com/DocuBook/editor/releases) page and drag DocuBook into Applications:

| DMG                              | Architecture | Mac                                   |
| -------------------------------- | ------------ | ------------------------------------- |
| `DocuBook_<version>_aarch64.dmg` | arm64        | Apple Silicon (M1/M2/M3/M4…) — native |
| `DocuBook_<version>_x64.dmg`     | x86_64       | Intel; Apple Silicon via Rosetta 2    |

**First launch** — builds are **not notarized** (until the project sponsors Apple Developer signing/notarization), so Gatekeeper blocks the first open. The dialog differs by arch (not a malware warning):

- **Apple Silicon (`aarch64.dmg`)** — _"app is damaged"_. macOS launchd refuses to spawn an **unsigned** arm64 binary (`RBSRequestErrorDomain Code=5`), so the build keeps an **ad-hoc signature**; with the download quarantine flag still on, Gatekeeper reads that signature as invalid and reports "damaged." There is **no Open Anyway** button for this case — clear the quarantine flag once:
  ```sh
  xattr -cr /Applications/DocuBook.app
  open /Applications/DocuBook.app
  ```
- **Intel (`x64.dmg`)** — _"developer cannot be verified."_ The x86_64 build is shipped **unsigned** (launchd tolerates this on Intel), so the standard Gatekeeper bypass applies:
  - Right-click **DocuBook** in Applications → **Open** → **Open**, or
  - System Settings → Privacy & Security → **Open Anyway**, or
  - the same `xattr -cr /Applications/DocuBook.app` one-liner above.

  Do the bypass once — the app opens normally afterwards.

**Verify your build:**

```sh
file /Applications/DocuBook.app/Contents/MacOS/DocuBook
# → "Mach-O thin (arm64)" = Apple Silicon · "Mach-O thin (x86_64)" = Intel

codesign -dv /Applications/DocuBook.app 2>&1 | head -1
# arm64 → "Signature=adhoc" (required: launchd spawn gate)
# x64   → "code object is not signed at all" (expected until notarization)

spctl -a -t exec -vv /Applications/DocuBook.app
# "rejected" is expected until notarization is added
```

### First run (both)

- **Web**: open the URL → the setup wizard creates the admin account (or provision headless with `DB_ADMIN_EMAIL` + `DB_ADMIN_PASSWORD`, both required). Data lives in the `/data` volume — back it up.
- **Desktop**: open the app → welcome screen → **Open Folder** (an existing folder of `.md` files), **Create New Vault**, or **Clone Repository** (paste a git URL). Vaults are plain local folders — no lock-in.
- **Connect AI**: Settings → **AI** — pick a provider, paste your API key. Keys are stored **backend-side only** (macOS Keychain on desktop, a 0600 file in `/data` on web) and never leave the machine.
- **Publish with Git**: Settings → **Git** — set commit name/email and add a remote. Private repos use your Keychain / SSH keys on desktop; the container's git identity on web.
- **Start writing**: click a file in the sidebar, type `/` for slash commands, use the **Code** button to toggle WYSIWYG/markdown. See [Usage](#usage).

### Troubleshooting (both)

- **Desktop launch fails on Apple Silicon** with _"Launch failed" / POSIX 163_ — a **stripped** (unsigned) arm64 build reached the machine: redownload `aarch64.dmg` and re-run `xattr -cr`.
- **AI not responding** (either platform): check the provider key in Settings → AI and that your network allows the provider endpoint.
- **Git publish failing**: check identity/remote in Settings → Git; on web also confirm the container's git identity is configured.

---

## Features

### Vault System (Obsidian-like)

- Open any folder as a vault — your files stay local, no lock-in
- File tree with depth-based indentation, dotfiles support
- CRUD — create files/folders, rename, delete via right-click context menu
- Search files by filename (like Zed/Obsidian Cmd+F)
- Frontmatter (YAML) auto-extracted, preserved during edits
- **.md** files open in WYSIWYG editor (fully supported)
- All other file types (`.mdx`, `.markdown`, JSON, TOML, YAML, etc.) open in view-only mode

### WYSIWYG Block Editor (Notion-like)

- BlockNoteJS — Notion-style block-based rich text editor
- Slash command menu (`/`) to insert headings, lists, quotes, code blocks, dividers
- Bubble menu for inline formatting (bold, italic, code, link, highlight)
- Markdown source mode — toggle between WYSIWYG and raw markdown (code mode)
- **.md files only** — WYSIWYG mode supports standard CommonMark markdown
- Non-`.md` files (`.mdx`, `.markdown`, etc.) open in view-only mode

### AI Assistant

- Inline AI powered by BlockNote XL (`@blocknote/xl-ai`) + custom Rust backend
- Slash menu and toolbar AI commands: write, improve, summarize, translate, fix spelling, and more
- Keyboard shortcut: `Ctrl+Alt+L` to open AI menu
- API keys configured in **Settings** — stored in macOS Keychain only, never localStorage
- **100+ providers** with **1,000+ models** — auto-synced from [models.dev](https://models.dev) into `frontend/data/providers.ts` (the generated catalog is the single source of truth; currently 174 providers / 5,482 models)

> [!NOTE]\
> **Every AI response becomes a reviewable suggestion.** The editor converts model output into `applyDocumentOperations` — either from the model's own tool call (`toolCall: true` models, the majority of the 1,000+ catalog) or generated from plain-text output (models without tool-call support, incl. `opencode-go`). In both cases the result appears as a tracked-change suggestion with **accept/reject** buttons before it touches the document. Output is guarded: referenced block ids must exist in the document (invalid ids trigger an automatic retry), and unclosed code fences are auto-closed before parsing.

**Popular Providers** (all support the accept/reject suggestion flow):

| Provider      | Notable models                       |
| ------------- | ------------------------------------ |
| OpenAI        | gpt-4o-mini, gpt-4o, gpt-5.6         |
| Anthropic     | claude-haiku-4.5, sonnet-4, opus-5   |
| Google Gemini | gemini-2.0-flash, 2.5-pro, 3.6-flash |
| DeepSeek      | v4-flash, reasoner, v4               |
| Mistral AI    | small, medium, large                 |
| Groq          | llama-3.1-8b, llama-3.3-70b          |
| Cohere        | command-r7b, command-a               |
| Perplexity    | sonar, sonar-pro                     |

**Provider data** is auto-generated from [models.dev/api.json](https://models.dev/api.json) — an open-source database of AI model specs, pricing, and capabilities. Run `curl https://models.dev/api.json` to get the latest data.

### Git Integration

- Save — stage all changes (git add -A)
- Publish — commit + push with auto-generated message
- Git branch displayed in status bar
- Disabled state tracking — Publish only enabled after staging

### Sidebar

- Vault file tree with expandable folders
- Search files modal (filename-based, recursive)
- Backlinks panel for current file (wikilinks)
- Bottom toolbar: Open vault, Search files, New file/folder

---

## Stack

| Layer    | Tech                            |
| -------- | ------------------------------- |
| Frontend | React 19, TypeScript 6, Zustand |
| UI       | Tailwind CSS v4, Lucide icons   |
| Editor   | BlockNoteJS 0.52 (ProseMirror)  |
| Backend  | Rust with Tauri v2              |
| Build    | Vite 8 + Rolldown               |
| Markdown | pulldown-cmark (Rust)           |

---

## Build from Source

See [CONTRIBUTING.md](./CONTRIBUTING.md) for prerequisites, building, cross-compiling, and the project layout.

---

## Usage

1. Launch the app — click Open Vault (folder icon in sidebar)
2. Select a folder containing .md files
3. Click a file in the sidebar tree — opens in WYSIWYG editor
4. Type `/` for slash commands, select text for bubble formatting
5. Use Code button to toggle between editor / markdown source
6. Save — stages changes, Publish — commit + push
7. Toggle AI in toolbar for AI assistance

> **Note:** Only `.md` files are fully supported in WYSIWYG mode. Other extensions (`.mdx`, `.markdown`, `.txt`, etc.) open in view-only mode.

### Keyboard Shortcuts

| Shortcut                         | Action                                           |
| -------------------------------- | ------------------------------------------------ |
| `Ctrl/Cmd+J`                     | Toggle sidebar                                   |
| `Ctrl/Cmd+F` / `Ctrl/Cmd+P`      | Open file search                                 |
| `Ctrl/Cmd+O`                     | Open vault / project folder                      |
| `Ctrl/Cmd+Shift+E`               | Toggle WYSIWYG / Markdown                        |
| `Ctrl/Cmd+Z` / `+Shift+Z` / `+Y` | Undo / Redo                                      |
| `Ctrl/Cmd+N`                     | New file                                         |
| `Ctrl/Cmd+Alt+N`                 | New folder                                       |
| `Ctrl+Alt+L`                     | Ask AI / Write with AI (opens AI menu at cursor) |
| `Ctrl/Cmd+,`                     | Settings (AI + Git)                              |
| `/` (in editor)                  | Slash command menu                               |
| `↑` / `↓` / `Enter`              | Navigate search results                          |
| `Enter` (on create/rename)       | Confirm                                          |
| `Escape` (on create/rename)      | Cancel                                           |

Writing shortcuts (built-in, no setup needed):

| Shortcut                                       | Action                                    |
| ---------------------------------------------- | ----------------------------------------- |
| `Tab` / `Shift+Tab`                            | Indent / outdent block                    |
| `Enter` / `Shift+Enter`                        | New block / line break                    |
| `Ctrl/Cmd+B` / `+I` / `+U` / `+K` / `+Shift+S` | Bold / Italic / Underline / Link / Strike |
| `Ctrl/Cmd+E`                                   | Inline code                               |
| `Shift+Cmd+↑` / `+↓`                           | Move block up / down                      |
| `Ctrl/Cmd+Alt+0`                               | Paragraph                                 |
| `Ctrl/Cmd+Alt+1`–`5`                           | Heading level 1–5                         |
| `Ctrl/Cmd+Alt+Q`                               | Quote                                     |
| `Ctrl/Cmd+Shift+6`                             | Toggle list                               |
| `Ctrl/Cmd+Shift+7`                             | Numbered list                             |
| `Ctrl/Cmd+Shift+8`                             | Bullet list                               |
| `Ctrl/Cmd+Shift+9`                             | Checklist                                 |
| `#` + `Space`                                  | Toggle heading                            |
| `-` + `Space`                                  | Toggle bullet list                        |
| `1.` + `Space`                                 | Toggle numbered list                      |
| `[]` + `Space`                                 | Toggle checklist                          |
| `>` + `Space`                                  | Toggle quote                              |
| ` ``` ` + `Space`                              | Toggle code block                         |

---

## License

[GPL-3.0](./LICENSE) — DocuBook now integrates BlockNote XL package (`@blocknote/xl-ai`) which is licensed under GPL-3.0. The GPL ensures that modified versions of the app remain free and open — if you distribute the app, you must share your changes under the same license.

### Commercial Use

**GPL-3.0 permits commercial use** — you may sell the app, host it as a service, or use it internally, as long as you comply with the copyleft obligations (offer source, keep it under GPL-3.0, preserve notices). No permission is required for standard commercial use.

The **optional cooperation clause** below is a separate, voluntary arrangement — it is NOT a GPL requirement and does not restrict what the license already permits:

> If you would like to work with the author directly — for example, running DocuBook as a dedicated managed service or building an AI gateway/provider on top of it — reach out to arrange cooperation: [email@wildan.dev](mailto:email@wildan.dev)

> [!NOTE]
> **Personal and community use remains free forever.** Using DocuBook for yourself, your studies, or your community — on your own devices or your own server — always stays free and open source.
