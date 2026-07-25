# Allocation Audit — Editor

## Cross-Sprint Validation

Memeriksa apakah task dependency, resource allocation, dan timeline konsisten antar sprint.

### Task Overlap Check

| Task | Sprint | Depends On | Sprinted Before? | Status |
|------|--------|------------|------------------|--------|
| BS-01 Wails init | S1 | — | ✅ S1.1 | ✅ OK |
| BS-02 Frontend setup | S1 | BS-01 | ✅ S1.2-1.3 | ✅ OK |
| BS-03 Preview bundle | S1 | BS-01 | ✅ S1.6 | ✅ OK |
| Vault CRUD | S3 | BS-01, BS-02 | ✅ S3.1-3.2 | ✅ OK |
| File tree HTMX | S3 | BS-02, Vault CRUD | ✅ S3.3 | ✅ OK |
| Goldmark parser | S3 | Vault CRUD | ✅ S3.4 | ✅ OK |
| docu.json editor | S4 | Vault CRUD | ✅ S4.1 | ✅ OK |
| Git push | S4 | docu.json | ✅ S4.2 | ✅ OK |
| Wiki links | S5 | Goldmark parser | ✅ S5.1-5.3 | ✅ OK |
| Backlinks | S5 | Wiki links | ✅ S5.4 | ✅ OK |
| Tags | S6 | Goldmark parser | ✅ S6.1-6.2 | ✅ OK |
| Full-text search | S6 | Vault CRUD, Goldmark | ✅ S6.3-6.4 | ✅ OK |
| File watcher | S7 | Vault CRUD | ✅ S7.1 | ✅ OK |
| Graph view | S7 | Wiki links | ✅ S7.2-7.3 | ✅ OK |
| AI agent | S8 | — | ✅ S8.1-8.2 | ✅ OK |

### Dependency Gap Analysis

| Sprint | Missing Dependency | Risk |
|--------|-------------------|------|
| S1 | None | — |
| S2 | @docubook/mdx-content harus publish sebelum S2 | Medium — bisa fallback ke basic markdown render |
| S3 | None | — |
| S4 | docu.json schema harus didefinisikan sebelum S4 | Low — bisa parallel dengan S3 |
| S5 | Goldmark wikilink extension | Low — bisa custom parser |
| S6 | Bleve harus integrasi | Medium — perlu spike di S5 |
| S7 | fsnotify + D3.js | Low — library stabil |
| S8 | AI provider API key flow | Medium — perlu desain UX dulu |

### Resource Contention

| Sprint | Go Tasks | JS/TS Tasks | Conflict? |
|--------|----------|-------------|-----------|
| S1 | 4 (BS-01, S1.1-1.2, app.go) | 2 (S1.3-1.6) | Low — Go + frontend parallel |
| S2 | 3 (S2.1, S2.4-2.5) | 2 (S2.2-2.3) | Low |
| S3 | 4 (S3.1-3.2, S3.4-3.6) | 1 (S3.3) | Low |
| S4 | 3 (S4.2-4.4) | 1 (S4.1) | Low |
| S5 | 3 (S5.1, S5.3-5.4) | 2 (S5.2, S5.5) | Medium — wikilink parser Go + autocomplete frontend |
| S6 | 2 (S6.3-6.4) | 2 (S6.1-6.2) | Low |
| S7 | 2 (S7.1, S7.4) | 2 (S7.2-7.3) | Low |
| S8 | 3 (S8.1-8.2, S8.4) | 2 (S8.3, S8.5) | Medium — AI agent Go + UI |
| CI | 0 | 0 | .github/workflows/build.yml — matrix: amd64 + arm64 |

### Buffer & Risk Reserve

| Sprint | Est Hours | Available | Buffer | Risk Items |
|--------|-----------|-----------|--------|------------|
| S1 | 15h | 25h | 10h | Wails setup issues (Go version, CGo) |
| S2 | 12h | 25h | 13h | @docubook/mdx-content integration |
| S3 | 18h | 25h | 7h | File tree performance, goldmark edge cases |
| S4 | 10h | 25h | 15h | Git exec error handling |
| S5 | 16h | 25h | 9h | Wikilink parser complexity |
| S6 | 12h | 25h | 13h | Bleve query performance |
| S7 | 14h | 25h | 11h | fsnotify edge cases, D3.js perf |
| S8 | 16h | 25h | 9h | AI provider integration, installer packaging |

### Recommendation

1. **S5-S6 overlap risk:** Wikilinks + Backlinks + Tags punya shared dependency ke goldmark. Consider merge S5-S6 jadi 1 sprint jika goldmark extension butuh banyak iterasi.
2. **S2 preview risk:** Jika @docubook/mdx-content belum rilis, S2.2 bisa blocking. Siapkan fallback: render markdown dasar dengan goldmark → HTML.
3. **S8 AI agent:** SSE streaming + UI overlay butuh desain matang. Mulai desain di S7.
4. **QA window:** Testing terbatas sampai S4. Mulai QA part-time dari S4, full-time di S7.
