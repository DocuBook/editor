# Acceptance Criteria — Editor (EARS Format)

## Vault Management

### F1: Open Vault
- **WHEN** user clicks "Open Vault", **THEN** native folder picker muncul
- **WHEN** folder selected, **THEN** vault di-load, file tree muncul di sidebar
- **WHEN** folder tidak punya file .md, **THEN** tampilkan "Empty vault" dengan tombol create note
- **WHEN** folder sudah jadi vault di sesi sebelumnya, **THEN** auto-reopen vault di startup

### F2: File Tree
- **WHEN** vault loaded, **THEN** sidebar tampilkan hierarki folder/file
- **WHEN** user klik folder, **THEN** expand/collapse children
- **WHERE** file adalah .md, **THEN** tampilkan dengan ikon file markdown
- **WHERE** ada file non-.md, **THEN** tampilkan tapi greyed out
- **WHEN** user right-click file, **THEN** context menu: Rename, Delete, Copy Path
- **WHILE** rename in progress, **THEN** inline edit field muncul

## Markdown Editor

### F5: CodeMirror 6
- **WHEN** file dibuka, **THEN** CodeMirror 6 load dengan syntax highlighting markdown
- **WHEN** user mengetik, **THEN** preview update real-time (<200ms debounce)
- **WHEN** user scroll editor, **THEN** preview scroll sinkron (optional, configurable)
- **WHERE** file >1MB, **THEN** tampilkan warning "Large file" sebelum load

### F6: Split Pane
- **WHEN** toggle split, **THEN** editor kiri, preview kanan dengan resize handle
- **WHERE** window <800px, **THEN** tab toggle bukan split
- **WHEN** resize handle di-drag, **THEN** rasio 50/50 default, bisa diubah

## Preview

### F9: mdx-content Render
- **WHEN** markdown berubah, **THEN** preview re-render via @docubook/mdx-content
- **WHERE** markdown invalid, **THEN** preview show error inline (bukan white screen)
- **WHEN** frontmatter YAML error, **THEN** preview show parse error, editor tetap bisa nulis

## Wiki System

### F11: Wikilinks
- **WHEN** user ketik `[[`, **THEN** autocomplete popup muncul dalam 200ms
- **WHERE** tidak ada note matching, **THEN** tampilkan "Create new note: [title]"
- **WHEN** user pilih autocomplete, **THEN** insert `[[title]]` dengan path resolved
- **WHEN** wikilink di-hover, **THEN** tooltip preview note content

## Tags

### F14: Inline Tags
- **WHEN** user ketik `#tag`, **THEN** tag terdeteksi dan highlighted
- **WHERE** tag mengandung spasi, **THEN** wrap dengan `#[[tag name]]`

## Search

### F16: Full-text
- **WHEN** user ketik query, **THEN** hasil muncul dalam 500ms
- **WHEN** tidak ada hasil, **THEN** tampilkan "No results found"
- **WHERE** query <2 chars, **THEN** jangan search (minimum 2 char)

## DocuBook Integration

### F18: docu.json Editor
- **WHEN** vault punya docu.json, **THEN** tab "Project Config" muncul di settings
- **WHEN** docu.json invalid JSON, **THEN** validasi error, simpan dicegah

### F19: Git Push
- **WHEN** user klik Push, **THEN** git status check dulu
- **WHERE** tidak ada perubahan, **THEN** button disabled, "Nothing to push"
- **WHEN** push gagal, **THEN** error message detail (bukan "Error")

## AI Agent

### F20: Inline AI
- **WHEN** user select text + trigger AI, **THEN** streaming response muncul di overlay
- **WHERE** tidak ada koneksi internet, **THEN** tampilkan "No connection"
- **WHEN** response selesai, **THEN** user bisa Accept/Modify/Reject
