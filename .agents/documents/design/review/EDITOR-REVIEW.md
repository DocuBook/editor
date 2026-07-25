# System Design Review — Editor

## Scalability

| Dimensi | Kapasitas | Bottleneck | Recommendation |
|---------|-----------|------------|----------------|
| File vault | 50K files | Bleve index + file tree render | Content-addressable cache, lazy loading tree |
| Note size | 100MB/file | CodeMirror rendering | Virtual rendering, plain text fallback |
| Concurrent edits | N/A (single user desktop) | — | — |
| Preview render | Unlimited (markdown→HTML) | @docubook/mdx-content performance | Memoize render, debounce input |
| Git operations | Repo size | Go git exec | Progress bar, timeout handling |

## Security

| Threat | Severity | Mitigation |
|--------|----------|------------|
| Path traversal (../ outside vault) | High | Validasi semua path input, reject path di luar vault root |
| XSS via preview render | High | @docubook/mdx-content handles sanitasi, DOMPurify di output |
| Git credential exposure | Medium | Jangan simpan credentials, delegasi ke git credential helper |
| Arbitrary file read via symlink | Medium | Option untuk follow/no-follow symlink, default no-follow |
| Code injection via file name | Low | Escape saat render di UI, jangan eval |

## Reliability

| Concern | Approach |
|---------|----------|
| Data integrity | Atomic writes (write to temp, rename), autosave setiap 30s |
| File watcher reliability | fsnotify + periodic full-scan (5 menit) |
| Crash recovery | Unsaved changes recovery via session file |
| Git push failure | Retry 3x, rollback on failure |
| Preview render crash | Error boundary di React, fallback raw markdown |

## Maintainability

| Aspect | Decision | Rationale |
|--------|----------|-----------|
| HTML fragments via HTMX | Server-driven UI, business logic di Go | Easy to debug, test, modify |
| Standalone preview bundle | decoupled React bundle | Preview logic independen dari chrome |
| Bleve index | Persistent, rebuild-able | Index bisa dihapus dan di-rebuild dari file |
| Config via docu.json | File-based, JSON | Portable, version-controlled, human-readable |

## Performance Budget

| Operation | Target | Measurement |
|-----------|--------|-------------|
| App startup | <1s | Wails dev build |
| Vault load (1000 files) | <2s | File scan + index |
| Search query | <500ms | Bleve query latency |
| Preview update | <200ms | Debounced render cycle |
| File switch tab | <100ms | CodeMirror swap + preview |
| Git push | <10s (1MB repo) | git add + commit + push |

## Dependency Audit

| Library | Risk | Alternative |
|---------|------|-------------|
| Wails v2 | Medium — Go version dependency | Tauri (Rust) |
| chi | Low — mature, maintained | stdlib net/http |
| goldmark | Low — CommonMark compliant | go-markdown |
| bleve | Medium — project less active | bluge (successor) |
| fsnotify | Low — mature | inotify manual |
| @docubook/mdx-content | Medium — internal API stability | Version-pin |
