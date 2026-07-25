# Task Graph — Editor Blueprint (P0-P8A)

## P0: Session + Bootstrap
| Kode | Task | Depends On |
|------|------|------------|
| EDITOR-BS-01 | Init project — Wails init, Go module, pnpm workspace | — |
| EDITOR-BS-02 | Setup frontend: HTMX + Alpine.js + Tailwind v4 + CodeMirror 6 | BS-01 |
| EDITOR-BS-03 | Setup preview bundle: build pipeline @docubook/mdx-content | BS-01 |

## P1: Idea Validation
| Kode | Task | Depends On |
|------|------|------------|
| EDITOR-IV-01 | Problem identification — kenapa butuh editor baru? | BS-03 |
| EDITOR-IV-02 | Target user — developer documentation writer, note-taker | IV-01 |
| EDITOR-IV-03 | Value proposition — "Zed + Obsidian + DocuBook" unique angle | IV-02 |
| EDITOR-IV-04 | Competitor analysis — Zed vs Obsidian vs VS Code vs Typora | IV-01 |
| EDITOR-IV-05 | Assumption mapping — asumsi berisiko tinggi | IV-03 |
| EDITOR-IV-06 | MVP scope definition — P0 scope (MoSCoW) | IV-05 |

## P2: Requirements
| Kode | Task | Depends On |
|------|------|------------|
| EDITOR-RP-01 | User stories — vault, editor, preview, AI, git push | IV-06 |
| EDITOR-RP-02 | Acceptance criteria — EARS format | RP-01 |
| EDITOR-RP-03 | BDD scenarios — Gherkin | RP-01 |
| EDITOR-RP-04 | Feature decomposition — breakdown per feature | RP-02 |
| EDITOR-RP-05 | Edge case catalog — null states, errors, conflicts | RP-02 |
| EDITOR-RP-06 | Risk register — technical, operational, delivery | RP-04 |

## P3: Technical Planning
| Kode | Task | Depends On |
|------|------|------------|
| EDITOR-TP-01 | Architecture design — Go + HTMX + Wails component map | RP-06 |
| EDITOR-TP-02 | Domain modeling — Vault, Note, Tag, Wikilink entities | TP-01 |
| EDITOR-TP-03 | API contract design — endpoint definitions | TP-01 |
| EDITOR-TP-04 | Database schema — search index (bleve), config | TP-02 |
| EDITOR-TP-05 | System design review — scalability, security | TP-03 |

## P4: UI Design
| Kode | Task | Depends On |
|------|------|------------|
| EDITOR-UX-01 | Screen wireframes — layout editor (Zed-like) | TP-01 |
| EDITOR-UX-02 | Navigation structure — vault tree, tabs, command palette | UX-01 |
| EDITOR-UX-03 | Component inventory — sidebar, preview, status bar | UX-01 |
| EDITOR-UX-04 | Design system tokens — Zed theme (dark/light) | UX-03 |

## P5: Test Planning
| Kode | Task | Depends On |
|------|------|------------|
| EDITOR-QA-01 | Test pyramid strategy — unit vs integration vs e2e | TP-05 |
| EDITOR-QA-02 | Test case matrix — per feature | QA-01 |

## P6: Documentation
| Kode | Task | Depends On |
|------|------|------------|
| EDITOR-PD-01 | BRD — Business Requirements Document | RP-06 |
| EDITOR-PD-02 | PRD — Product Requirements Document | RP-06 |
| EDITOR-PD-03 | FSD — Functional Specification Document | UX-04 |
| EDITOR-PD-04 | TDD — Technical Design Document | TP-05 |
| EDITOR-PD-05 | ADR — Architecture Decision Records | TP-05 |

## P7: Delivery Planning
| Kode | Task | Depends On |
|------|------|------------|
| EDITOR-DP-01 | Roadmap creation — full delivery horizon | PD-04 |
| EDITOR-DP-02 | Sprint manifest — sprint count, velocity, capacity | DP-01 |
| EDITOR-DP-03 | Sprint plans — sprint-1 sampai sprint-N | DP-02 |
| EDITOR-DP-04 | Allocation audit — cross-sprint validation | DP-03 |

## P8: Application Documentation
| Kode | Task | Depends On |
|------|------|------------|
| EDITOR-AD-01 | Module docs — vault, editor, preview, AI, git | DP-04 |
| EDITOR-AD-02 | API docs — endpoint contracts | AD-01 |
| EDITOR-AD-03 | Testing docs — test matrix per module | AD-01 |
| EDITOR-AD-04 | Blueprint audit — D1-D6 validation | AD-03 |
