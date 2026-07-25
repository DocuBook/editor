# Testing Matrix — Editor

## Positive Cases

| ID | Module | Test | Expected |
|----|--------|------|----------|
| P1 | Vault | Open folder → vault loads | File tree muncul |
| P2 | Vault | Create file → file appears | 200 OK, tree refresh |
| P3 | Vault | Rename file → path updated | 200 OK |
| P4 | Vault | Delete file → removed from tree | 200 OK |
| P5 | Editor | Type markdown → preview updates | Real-time |
| P6 | Editor | Save → file written to disk | Content match |
| P7 | Preview | Render Mermaid → diagram visible | Renders |
| P8 | Preview | Render CodeBlock → syntax highlight | Highlighted |
| P9 | Wiki | Type [[ → autocomplete popup | Shows suggestions |
| P10 | Wiki | Select suggestion → [[link]] inserted | Resolved path |
| P11 | Tags | #tag in content → detected | Shows in tag pane |
| P12 | Search | Full-text search → results | Relevant files |
| P13 | Git | Push → git add+commit+push | 200, commit hash |
| P14 | Config | Edit docu.json → saved | File written |

## Negative Cases

| ID | Module | Test | Expected |
|----|--------|------|----------|
| N1 | Vault | Open non-existent path | Error message |
| N2 | Vault | Create file with invalid chars | Validation error |
| N3 | Vault | Delete non-existent file | 404 |
| N4 | Editor | Open binary file | Read-only warning |
| N5 | Preview | Invalid markdown | Graceful fallback |
| N6 | Wiki | [[link to non-existent note]] | Grey/dashed style |
| N7 | Search | Empty query | No results, hint |
| N8 | Git | No git repo | Error: init or config |
| N9 | Git | Git push fails (network) | Error message + retry |
| N10 | Config | Invalid docu.json JSON | Validation error |

## Edge Cases

| ID | Module | Test | Expected |
|----|--------|------|----------|
| E1 | Vault | Vault with 10,000 files | Lazy load tree |
| E2 | Vault | File renamed externally | Watcher detects |
| E3 | Editor | Very large file (>10MB) | Warning: read-only |
| E4 | Preview | Nested Mermaid + CodeBlock | Both render |
| E5 | Wiki | Circular wikilinks | No infinite loop |
| E6 | Tags | 1000+ unique tags | Scroll + search |
| E7 | Search | Special characters in query | Escaped properly |

## Security Cases

| ID | Module | Test | Expected |
|----|--------|------|----------|
| S1 | Vault | Path traversal attempt | Blocked |
| S2 | Git | Git credentials leak | Not in output |
| S3 | Agent | AI prompt injection | Sanitized |
