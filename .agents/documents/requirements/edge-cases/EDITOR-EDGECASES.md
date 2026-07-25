# Edge Case Catalog — Editor

## Vault

| Skenario | Expected Behavior |
|----------|------------------|
| Folder berisi 10.000+ file | Load async dengan progress indicator, virtual scroll di tree |
| Folder dipindah/dihapus external | Watcher deteksi → update tree + show badge "moved/deleted" |
| Dua vault dengan path sama | Error "Vault already open", fokus ke vault yang sudah open |
| File .md 0 bytes | Tampilkan editor kosong, bukan error |
| File .md 100MB | Warning sebelum load, syntax highlighting dimatikan, plain text |
| Nama file mengandung karakter spesial | Path encoding aman, test: spasi, `#`, `?`, `[]`, emoji, CJK |
| File dihapus external saat sedang diedit | Watcher deteksi → show "File deleted" toast, tawarkan save as |
| Vault root tidak writable | Baca-saja mode, UI greyed out untuk create/rename/delete |
| Symlink di dalam vault | Follow symlink untuk file .md, warning icon di tree |
| Hidden files/folders (.git, .obsidian) | Jangan tampilkan di tree (kecuali ada toggle "Show hidden") |

## Editor

| Skenario | Expected Behavior |
|----------|------------------|
| Paste 10MB konten | Load async, jangan freeze UI |
| Unicode/corrupted file | UTF-8 detection, fallback ke binary mode + warning |
| CRLF vs LF | Deteksi line ending, maintain existing format |
| Undo stack >1000 | Compact history, limit 10.000 entries |
| Multiple tabs sama file | Focus ke tab yang sudah ada, jangan duplicate |
| File berubah external saat editing | Watcher deteksi → prompt: "Keep editor version / Reload from disk" |
| Autosave conflict (save saat external change) | Tulis dulu ke .md.bak, lalu notifikasi konflik |

## Preview

| Skenario | Expected Behavior |
|----------|------------------|
| Markdown syntax error | Render partial, error inline di area error, bukan crash |
| Custom component error | Fallback ke raw HTML, error di console preview |
| Image path broken | Image placeholder broken-icon, tooltip path |
| Responsive preview | Render di iframe dengan viewport yang bisa di-resize |
| Re-render loop (>10/detik) | Debounce ke 500ms throttle, bukan setiap keystroke |

## Wiki Links

| Skenario | Expected Behavior |
|----------|------------------|
| Wikilink ke note yang belum dibuat | Tampilkan berbeda (dashed underline), "Create on click" |
| Wikilink circular (A→B→C→A) | Jangan infinite loop di backlinks/graph, deteksi cycle |
| Wikilink dengan alias `[[title|alias]]` | Display alias, link ke title |
| Wikilink ke note yang dihapus | Show broken link, suggestion "Create / Remove link" |
| Ribuan wikilink dalam satu vault | Backlinks query must have index, <500ms |

## Tags

| Skenario | Expected Behavior |
|----------|------------------|
| Tag dalam frontmatter dan inline sama | Merge, jangan duplicate di tag pane |
| Tag dengan uppercase vs lowercase | Case-insensitive, normalisasi ke lowercase |
| Ribuan unique tags | Virtual scroll di tag pane, search/filter |

## Search

| Skenario | Expected Behavior |
|----------|------------------|
| Query SQL injection attempt | Bleve aman, tapi validasi input boundary |
| Search saat vault large (50K files) | Index async, progress bar, search tetap responsif |
| Regex/search operator injection | Escape atau reject karakter berbahaya |

## Git Push

| Skenario | Expected Behavior |
|----------|------------------|
| Git not installed | Deteksi, error jelas "Git not found", link install |
| Push ke remote yang berbeda | Konfirmasi, jangan overwrite tanpa prompt |
| Merge conflict | Abort push, tawarkan resolve manual via terminal |
| Network timeout | Retry 3x, lalu error dengan detail |
| docu.json invalid | Jangan push, validasi error, blocking |
