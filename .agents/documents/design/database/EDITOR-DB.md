# Database Schema — Editor

## Search Index (Bleve)

Bleve adalah full-text search engine pure Go. Index disimpan di `~/.local-memory-editor/search.bleve/`.

### Index Mapping

```json
{
  "mapping": {
    "note": {
      "properties": {
        "title":      {"type": "text", "analyzer": "standard"},
        "content":    {"type": "text", "analyzer": "standard"},
        "path":       {"type": "keyword"},
        "tags":       {"type": "keyword"},
        "created_at": {"type": "datetime"},
        "updated_at": {"type": "datetime"}
      }
    }
  }
}
```

### Search Queries

| Use Case | Query | Filter |
|----------|-------|--------|
| Full-text | `match query` pada content + title | — |
| By tag | — | `tags: tagname` |
| By path | — | `path: /docs/*` |
| Date range | — | `updated_at: >2025-01-01` |

## Config Storage

docu.json dibaca/tulis langsung dari vault root:

```json
{
  "meta": { "title": "...", "baseURL": "..." },
  "routes": [...],
  "navbar": {...},
  "sidebar": {...},
  "themes": { "colors": "default" }
}
```

## File Watcher (fsnotify)

| Event | Aksi |
|-------|------|
| CREATE | Add to tree, index for search |
| WRITE | Re-index, refresh preview |
| REMOVE | Remove from tree + index |
| RENAME | Update path in index |
