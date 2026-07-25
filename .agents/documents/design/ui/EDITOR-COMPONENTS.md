# Component Inventory — Editor

## Chrome Components (Wails)

| Component | Teknologi | State | Notes |
|-----------|-----------|-------|-------|
| Title Bar | HTML + CSS | static | Wails drag region, window controls |
| Theme Toggle | Alpine.js | dark / light | Persist ke localStorage |
| Command Palette | Alpine.js + HTMX | open / closed / filtering | Ctrl+P toggle |

## Sidebar

| Component | Teknologi | States | Notes |
|-----------|-----------|--------|-------|
| Vault List | HTMX | empty / loaded / error | Load dari chi server |
| File Tree Item | Alpine.js | collapsed / expanded / active / dragging | Hierarki recursive |
| Context Menu | Alpine.js | open / closed | Right-click position |
| Open Vault Button | HTMX | idle / loading | POST trigger |
| File Search Filter | Alpine.js | empty / filtering / no-results | Filter tree inline |

## Editor

| Component | Teknologi | States | Notes |
|-----------|-----------|--------|-------|
| Tab Bar | Alpine.js | empty / single / multiple / overflow | Scrollable |
| Tab Item | Alpine.js | active / inactive / modified / pinned | Modified = dot indicator |
| CodeMirror 6 | JS standalone | loading / empty / editing / large-file | Standalone, non-Alpine |
| Split Pane | CSS + JS | editor-only / split / preview-only | Resizable |
| Editor Status | Alpine.js | idle / saving / saved / error | Autosave indicator |

## Preview

| Component | Teknologi | States | Notes |
|-----------|-----------|--------|-------|
| Preview Frame | React bundle | loading / rendering / error | iframe atau div mount |
| Preview Toolbar | Alpine.js | — | Toggle mode, refresh |
| Error Overlay | React | visible / hidden | Parse error inline |

## Status Bar

| Component | Teknologi | States | Notes |
|-----------|-----------|--------|-------|
| Git Branch | HTMX | main / detached / no-git | Polling atau push-based |
| Cursor Position | Alpine.js | Ln:Col | Dari CodeMirror |
| Encoding | static | UTF-8 | Fixed untuk sekarang |
| App Status | Alpine.js | ready / saving / indexing / pushing | Global status |
| File Count | HTMX | N files | Vault summary |

## Modals & Overlays

| Component | Teknologi | States | Notes |
|-----------|-----------|--------|-------|
| File Rename | Alpine.js | inline edit / saving / error | Inline di tree |
| Delete Confirm | Alpine.js | open / closed | Konfirmasi sebelum delete |
| Git Push Progress | HTMX | idle / pushing / success / error | Progress bar |
| AI Chat Overlay | Alpine.js + SSE | closed / loading / streaming / complete / error | Bottom center overlay |
| Settings Panel | HTMX + Alpine | open / closed | Tabbed settings |

## Feedback Components

| Component | Teknologi | States | Notes |
|-----------|-----------|--------|-------|
| Toast | Alpine.js | visible / hidden / stacking | Auto-dismiss 3s |
| Loading Spinner | CSS | spin / stopped | HTMX request indicator |
| Empty State | CSS | — | Per panel (no vault, no file, no results) |
| Error State | CSS | — | Per panel dengan retry button |
