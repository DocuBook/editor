# Idea Validation — Editor

## 1. Problem Identification

### Root Cause
Developer documentation writers dan technical writers menggunakan 3+ tools terpisah:
- **Editor teks** (VS Code, Zed) untuk nulis markdown
- **Note-taking app** (Obsidian, Notion) untuk manage knowledge
- **Publishing tool** (Docusaurus, Nextra) untuk build docs site

### Pain Points
1. **Context switching** antara editor ↔ notes ↔ publish tools
2. **Preview mismatch** — markdown render di editor beda dengan hasil final
3. **Bundle size** — VS Code ~300MB untuk sekedar nulis markdown
4. **Vendor lock-in** — Obsidian proprietary, Notion no export bersih
5. **No unified pipeline** — dari draft → publish masih manual

### Impact
| Stakeholder | Problem | Cost |
|-------------|---------|------|
| Indie developer | Setup docs site butuh 3 tools + konfigurasi | 2-4 jam setup |
| Technical writer | Preview mismatch → repeated fixes | 20% waktu terbuang |
| Small team | No unified writing → publishing flow | 3+ tool subscriptions |

## 2. Target User Definition

### Primary Persona: Indie Developer

| Atribut | Value |
|---------|-------|
| Usia | 25-40 |
| Role | Full-stack / Indie developer |
| Tools | VS Code / Zed, Git, CLI |
| Pain | Butuh docs site untuk project, males setup Docusaurus |
| Goal | Write markdown → git push → published |
| Tech literacy | High |
| OS | macOS primary |

### Secondary Persona: Technical Writer

| Atribut | Value |
|---------|-------|
| Usia | 30-50 |
| Role | Technical writer |
| Tools | Obsidian, Notion, VS Code |
| Pain | Preview mismatch, no git publish |
| Goal | Single tool untuk write → review → publish |
| Tech literacy | Medium |

### Tertiary Persona: Knowledge Worker

| Atribut | Value |
|---------|-------|
| Usia | 20-45 |
| Role | Student / Researcher / PM |
| Tools | Obsidian, Notion, Apple Notes |
| Pain | Obsidian no publish, Notion vendor lock-in |
| Goal | Private note-taking + optional publish |
| Tech literacy | Low-Medium |

## 3. Value Proposition

### Core Promise
> **Satu desktop app untuk menulis markdown yang bisa langsung di-publish — secepat Zed, serapi Obsidian, sepraktis DocuBook.**

### Differentiators
| Against Us | Editor | Why Better |
|------------|--------|------------|
| Obsidian | ✅ Free, open source, git publish built-in | Obsidian: proprietary + publishing via plugin |
| VS Code | ✅ 10MB vs 300MB, preview = final output | VS Code: general purpose, berat |
| Zed | ✅ Markdown-first, built-in preview | Zed: code editor, markdown second-class |
| Typora | ✅ Git publish, vault management, open source | Typora: no git, no vault, closed source |
| Notion | ✅ Local-first, markdown files, no vendor lock | Notion: cloud-only, export messy |

### Unique Value
- **Satu tool, zero config** — buka folder → nulis → git push → published
- **Preview identik final** — yang dilihat di editor = yang di-deploy
- **10MB binary** — lightweight, instant startup

## 4. Competitor Analysis

| Feature | Editor | Zed | Obsidian | VS Code | Typora | Notion |
|---------|--------|-----|----------|---------|--------|--------|
| Markdown editor | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Live preview | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| Vault/file tree | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ |
| Wiki links | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Backlinks | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Graph view | ✅ (D3) | ❌ | ✅ | ❌ | ❌ | ❌ |
| Git publish | ✅ built-in | ✅ via ext | ❌ plugin | ✅ via ext | ❌ | ❌ |
| Static site gen | ✅ DocuBook | ❌ | ❌ plugin | ❌ | ❌ | ✅ (limited) |
| AI agent | ✅ SSE | ✅ | ❌ | ✅ Copilot | ❌ | ✅ |
| Open source | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| Bundle size | ~10MB | ~200MB | ~200MB | ~300MB | ~20MB | N/A (web) |
| Startup time | <1s | <1s | 2-3s | 3-5s | <1s | N/A |

## 5. Assumption Mapping

| # | Assumption | Confidence | Risk | Validation Method |
|---|------------|------------|------|-------------------|
| A1 | Developer mau tool dedicated markdown | Medium | High | Survey 20 devs: "Pakai apa untuk nulis docs?" |
| A2 | Preview = final adalah feature penting | High | Low | Validated via DocuBook users |
| A3 | 10MB cukup untuk semua fitur | High | Low | Wails binary size validated |
| A4 | Git push dari desktop adalah flow yang diinginkan | Medium | Medium | User interview |
| A5 | Vault system (Obsidian-like) diperlukan | High | Low | Obsidian 1M+ users validates demand |
| A6 | AI agent inline adalah feature pembeda | Medium | High | Competitor analysis, need MVP test |
| A7 | Multi-vault diperlukan | Low | Medium | Can be P2, validate after P0 |
| A8 | macOS first sudah cukup untuk launch | Medium | Medium | Target user demografi |

## 6. MVP Scope Definition (MoSCoW)

### Must Have (P0) — Launch Critical
- ✅ Vault: open folder, file tree CRUD
- ✅ Editor: CodeMirror 6, syntax highlighting
- ✅ Preview: @docubook/mdx-content render
- ✅ Layout: sidebar + editor + preview + status bar
- ✅ Git push (for project vaults)
- ✅ Dark/light theme
- ✅ macOS support (arm64 + x64)

### Should Have (P1) — Important, not critical
- Wiki links + backlinks
- Tags (inline + frontmatter)
- Full-text search (bleve)
- Multi-vault

### Could Have (P2) — Nice to have
- File watcher (fsnotify)
- Graph view (D3.js)
- AI agent (SSE streaming)
- Command palette

### Won't Have (Post-Launch)
- Windows / Linux support
- Mobile app
- Real-time collaboration
- Plugin system
- WYSIWYG mode (beyond preview)
