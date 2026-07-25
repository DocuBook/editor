# Risk Register — Editor

| # | Risk | Impact | Probability | Mitigation | Contingency |
|---|------|--------|------------|------------|-------------|
| R1 | Wails v2 compatibility dengan future Go versions | Medium | Low | Pin Go version di go.mod, CI test multiple versions | Migrate to Tauri jika Wails stale |
| R2 | @docubook/mdx-content API changes | High | Medium | Pin version di package.json, kontrak interface via TypeScript | Build adapter layer jika breaking changes |
| R3 | Bleve index corrupt | Medium | Low | Index di ~/.local-memory-editor/, auto-rebuild on version mismatch | Rebuild dari scan full vault |
| R4 | File watcher (fsnotify) miss events pada high volume | Medium | Medium | Debounce + periodic full-scan setiap 5 menit | Fallback ke periodic scan |
| R5 | Large vault performance (>10K files) | High | Medium | Lazy loading tree, virtual scroll, async index | Progressive enhancement — fitur non-kritis bisa lambat |
| R6 | Git push conflict dengan remote | Medium | Low | Stash + pull sebelum push, abort jika conflict | Manual resolve via terminal |
| R7 | macOS version compatibility (10+) | Low | Low | Test di macOS 10.15+ dan 14.x | Minimum target 10.0, test di versi terbaru |
| R8 | Security: arbitrary file access via vault | High | Low | Path traversal validation, vault root boundary | Sandboxed fs access |
| R9 | Data loss: autosave vs external edit conflict | High | Medium | Conflict detection + backup ke .md.bak | Manual merge prompt |
| R10 | AI agent API cost / rate limit | Low | High | Token usage tracking, user-set budget, local fallback model | Clear error + usage stats |
| R11 | Multi-vault performance | Medium | Low | Separate index per vault, lazy load inactive vaults | Merge index jika diperlukan |
| R12 | Key binding conflict antara CodeMirror vs OS | Low | Low | Configurable keymap, detection overlay | Reset to defaults option |
