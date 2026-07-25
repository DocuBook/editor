# Functional Specification Document — Editor

## 1. Vault Management
| ID | Fungsi | Detail |
|----|--------|--------|
| ID | Fungsi | Detail | Status |
|----|--------|--------|--------|
| F1 | Open vault | Pilih folder → jadi vault, scan .md files | ✅ S3 |
| F2 | File tree | Sidebar hierarki, CRUD, drag-drop | ✅ S3 |
| F3 | File watcher | Deteksi perubahan eksternal (fsnotify) | ⏳ S7 |
| F4 | Multi-vault | Buka >1 vault, switch via sidebar | ⏳ S4 |

## 2. Markdown Editor
| ID | Fungsi | Detail | Status |
|----|--------|--------|--------|
| F5 | CodeMirror 6 | Syntax highlighting, line numbers, gutter | ✅ S1 |
| F6 | Split pane | Editor kiri, preview kanan | ✅ S2 |
| F7 | WYSIWYG | Toggle edit/preview mode | ⏳ future |
| F8 | Frontmatter | YAML editor inline | ⏳ S5 |

## 3. Preview
| ID | Fungsi | Detail | Status |
|----|--------|--------|--------|
| F9 | mdx-content render | React bundle, semua komponen DocuBook | ✅ S2 |
| F10 | Live update | Real-time saat ngetik | ✅ S2 |

## 4. Wiki System
| ID | Fungsi | Detail | Status |
|----|--------|--------|--------|
| F11 | Wikilinks | [[autocomplete]], resolve path | ⏳ S5 |
| F12 | Backlinks | Panel "Linked to this note" | ⏳ S5 |
| F13 | Graph view | D3.js visualisasi koneksi | ⏳ S7 |

## 5. Tags
| ID | Fungsi | Detail | Status |
|----|--------|--------|--------|
| F14 | Inline tags | #tag detection | ⏳ S6 |
| F15 | Tag pane | Sidebar filter by tag | ⏳ S6 |

## 6. Search
| ID | Fungsi | Detail | Status |
|----|--------|--------|--------|
| F16 | Full-text | Bleve index, cari semua file | ⏳ S6 |
| F17 | Filter | By path, tag, date | ⏳ S6 |

## 7. DocuBook Integration
| ID | Fungsi | Detail | Status |
|----|--------|--------|--------|
| F18 | docu.json | Editor GUI untuk config | ⏳ S4 |
| F19 | Git push | git add + commit + push → trigger CI | ⏳ S4 |

## 8. AI Agent
| ID | Fungsi | Detail | Status |
|----|--------|--------|--------|
| F20 | Inline AI | Select text → Ask AI (SSE streaming) | ✅ S8 |
