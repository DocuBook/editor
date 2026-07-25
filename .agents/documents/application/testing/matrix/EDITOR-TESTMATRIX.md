# Test Case Matrix — Editor

## Vault Management Module

| ID | Test | Type | Priority | Module | Automation |
|----|------|------|----------|--------|------------|
| TC-V-01 | Open valid vault with .md files | Integration | P0 | Vault | Manual |
| TC-V-02 | Open empty folder | Integration | P0 | Vault | Manual |
| TC-V-03 | Open non-existent path | Integration | P0 | Vault | Manual |
| TC-V-04 | File tree render correct hierarchy | Integration | P0 | Vault | Manual |
| TC-V-05 | Create new .md file | Integration | P0 | Vault | Manual |
| TC-V-06 | Rename file/folder | Integration | P0 | Vault | Manual |
| TC-V-07 | Delete file with confirmation | Integration | P0 | Vault | Manual |
| TC-V-08 | Multi-vault: open second vault | Integration | P1 | Vault | Manual |
| TC-V-09 | Vault with 10K files (performance) | Performance | P1 | Vault | Manual |
| TC-V-10 | Symlink handling | Edge | P2 | Vault | Manual |
| TC-V-11 | Hidden file visibility toggle | Edge | P2 | Vault | Manual |

## Editor Module

| ID | Test | Type | Priority | Module | Automation |
|----|------|------|----------|--------|------------|
| TC-E-01 | Open .md file in CodeMirror | Integration | P0 | Editor | Manual |
| TC-E-02 | Syntax highlighting markdown | Unit | P0 | Editor | Manual |
| TC-E-03 | Type content → preview updates | Integration | P0 | Editor | Manual |
| TC-E-04 | Open large file (>1MB) | Edge | P0 | Editor | Manual |
| TC-E-05 | Open binary/non-.md file | Edge | P0 | Editor | Manual |
| TC-E-06 | File modified externally while editing | Edge | P1 | Editor | Manual |
| TC-E-07 | Undo/redo history | Unit | P1 | Editor | Manual |
| TC-E-08 | Multi-tab management | Integration | P1 | Editor | Manual |
| TC-E-09 | Split pane resize | Integration | P1 | Editor | Manual |
| TC-E-10 | CRLF vs LF detection | Edge | P2 | Editor | Manual |
| TC-E-11 | Auto-save on tab close | Integration | P0 | Editor | Manual |
| TC-E-12 | Keyboard shortcuts navigation | Integration | P1 | Editor | Manual |

## Preview Module

| ID | Test | Type | Priority | Module | Automation |
|----|------|------|----------|--------|------------|
| TC-P-01 | Render valid markdown | Unit | P0 | Preview | Auto |
| TC-P-02 | Render with custom components | Unit | P0 | Preview | Auto |
| TC-P-03 | Invalid markdown handling | Unit | P0 | Preview | Auto |
| TC-P-04 | Frontmatter YAML error | Unit | P0 | Preview | Auto |
| TC-P-05 | Broken image path | Edge | P1 | Preview | Manual |
| TC-P-06 | Responsive preview iframe | Integration | P1 | Preview | Manual |
| TC-P-07 | Preview match with final build | Integration | P0 | Preview | Auto |

## Wiki Links Module

| ID | Test | Type | Priority | Module | Automation |
|----|------|------|----------|--------|------------|
| TC-W-01 | [[ autocomplete popup | Integration | P1 | Wiki | Manual |
| TC-W-02 | Autocomplete with no matches | Edge | P1 | Wiki | Manual |
| TC-W-03 | Click wikilink → navigate | Integration | P1 | Wiki | Manual |
| TC-W-04 | Wikilink to non-existent note | Edge | P1 | Wiki | Manual |
| TC-W-05 | Backlinks panel rendering | Integration | P1 | Wiki | Manual |
| TC-W-06 | Wikilink with alias `[[title|alias]]` | Unit | P1 | Wiki | Manual |
| TC-W-07 | Circular wikilink detection | Edge | P2 | Wiki | Manual |

## Tags Module

| ID | Test | Type | Priority | Module | Automation |
|----|------|------|----------|--------|------------|
| TC-T-01 | Inline #tag detection | Unit | P1 | Tags | Auto |
| TC-T-02 | Frontmatter tag parsing | Unit | P1 | Tags | Auto |
| TC-T-03 | Tag pane rendering | Integration | P1 | Tags | Manual |
| TC-T-04 | Click tag → filter notes | Integration | P1 | Tags | Manual |
| TC-T-05 | Case-insensitive tag merge | Unit | P1 | Tags | Auto |

## Search Module

| ID | Test | Type | Priority | Module | Automation |
|----|------|------|----------|--------|------------|
| TC-S-01 | Full-text search returns results | Integration | P1 | Search | Manual |
| TC-S-02 | Search with no results | Edge | P1 | Search | Manual |
| TC-S-03 | Search with <2 chars | Edge | P1 | Search | Manual |
| TC-S-04 | Search filter by tag | Integration | P2 | Search | Manual |
| TC-S-05 | Bleve index rebuild | Integration | P1 | Search | Manual |
| TC-S-06 | Performance: 50K files indexed | Performance | P2 | Search | Manual |

## Git Push Module

| ID | Test | Type | Priority | Module | Automation |
|----|------|------|----------|--------|------------|
| TC-G-01 | Push with changes (happy path) | Integration | P0 | Git | Manual |
| TC-G-02 | Push with no changes | Edge | P0 | Git | Manual |
| TC-G-03 | Push when git not installed | Edge | P0 | Git | Manual |
| TC-G-04 | Push with network error | Edge | P1 | Git | Manual |
| TC-G-05 | docu.json invalid → block push | Edge | P0 | Git | Manual |
| TC-G-06 | Push progress indicator | Integration | P1 | Git | Manual |

## AI Agent Module

| ID | Test | Type | Priority | Module | Automation |
|----|------|------|----------|--------|------------|
| TC-A-01 | Select text → Ask AI (online) | Integration | P2 | AI | Manual |
| TC-A-02 | Ask AI with no connection | Edge | P2 | AI | Manual |
| TC-A-03 | SSE streaming response | Integration | P2 | AI | Manual |
| TC-A-04 | Accept/Modify/Reject flow | Integration | P2 | AI | Manual |
| TC-A-05 | Rate limit / token budget | Edge | P2 | AI | Manual |

## UI/Chrome Module

| ID | Test | Type | Priority | Module | Automation |
|----|------|------|----------|--------|------------|
| TC-U-01 | Theme toggle dark/light | Integration | P0 | UI | Manual |
| TC-U-02 | Command palette open/close | Integration | P0 | UI | Manual |
| TC-U-03 | Command palette search | Integration | P1 | UI | Manual |
| TC-U-04 | Window resize responsive | Integration | P0 | UI | Manual |
| TC-U-05 | Keyboard shortcuts work | Integration | P0 | UI | Manual |
| TC-U-06 | Toast notifications | Integration | P2 | UI | Manual |
