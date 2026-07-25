# API Contracts — Editor

**Base:** `http://127.0.0.1:{port}/api` (dynamic port, lihat status bar)

> Tanpa versioning prefix (`/api/v1/` → `/api/`).

## Implemented

### GET /api/hello
Health check.

**Response:** HTML fragment

### GET /api/layout/sidebar
Sidebar file tree — jika vault terbuka tampilkan tree, jika tidak tampilkan "No vault" + tombol Open.

**Response:** HTML fragment

### GET /api/layout/status
Status bar — vault name, status.

**Response:** HTML fragment

### POST /api/vault/open
Open vault folder.

| Param | Type | Required |
|-------|------|----------|
| path | string | yes (form/query) |

**Response:** HTML fragment (file tree)

### GET /api/vault/tree
GET /api/vault/tree/{path}
File tree recursive — root atau subfolder.

**Response:** HTML fragment dengan nested `<div>` items

### GET /api/vault/file/{path}
Read file content + metadata (markdown parse).

**Response:**
```json
{
  "path": "docs/readme.md",
  "name": "readme.md",
  "content": "# Markdown...",
  "meta": {
    "headings": [{"level": 1, "text": "Title"}],
    "wordCount": 120,
    "frontmatter": {"title": "Readme"},
    "tags": ["docs"]
  }
}
```

### POST /api/vault/file
Create new file.

| Param | Type | Required |
|-------|------|----------|
| path | string | yes |
| content | string | no |

### POST /api/vault/rename
Rename file/folder.

| Param | Type | Required |
|-------|------|----------|
| old | string | yes |
| new | string | yes |

### POST /api/vault/delete
Delete file/folder.

| Param | Type | Required |
|-------|------|----------|
| path | string | yes |

### POST /api/vault/mkdir
Create folder.

| Param | Type | Required |
|-------|------|----------|
| path | string | yes |

### POST /api/vault/save
Save file content.

| Param | Type | Required |
|-------|------|----------|
| path | string | yes |
| content | string | yes |

## Planned (Sprint 5+)

| Endpoint | Sprint | Description |
|----------|--------|-------------|
| GET /api/wiki/suggest?q= | S5 | Wikilink autocomplete |
| GET /api/wiki/backlinks?path= | S5 | Backlinks for note |
| GET /api/search?q=&tag=&path= | S6 | Full-text search (bleve) |
| POST /api/git/push | S4 | Git add + commit + push |
| GET /api/agent/ask?text= | S8 | AI streaming (SSE) — token events |
| GET /api/config/docu | S4 | Read docu.json |
| PUT /api/config/docu | S4 | Update docu.json |
