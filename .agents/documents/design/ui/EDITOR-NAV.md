# Navigation Structure — Editor

## Route Map (Command Palette)

| Shortcut | Command | Action |
|----------|---------|--------|
| `Ctrl+P` | Command Palette | Fuzzy search all commands |
| `Ctrl+N` | New Note | Buat file .md baru di vault |
| `Ctrl+O` | Open Vault | Native folder picker |
| `Ctrl+S` | Save | Simpan file aktif |
| `Ctrl+W` | Close Tab | Tutup tab aktif |
| `Ctrl+Tab` | Next Tab | Cycle ke tab berikutnya |
| `Ctrl+Shift+Tab` | Previous Tab | Cycle ke tab sebelumnya |
| `Ctrl+B` | Toggle Sidebar | Show/hide sidebar |
| `Ctrl+J` | Toggle Preview | Show/hide preview pane |
| `Ctrl+,` | Settings | Buka settings panel |
| `Ctrl+Shift+P` | Push to Publish | Git add + commit + push |
| `Ctrl+Shift+F` | Search in Vault | Full-text search |
| `Ctrl+Shift+A` | AI Assistant | Buka AI panel |
| `Ctrl+D` | Toggle Dark/Light | Switch theme |
| `F11` | Fullscreen | Toggle fullscreen |

## Tab Bar Behavior

| Aksi | Hasil |
|------|-------|
| Click tab | Switch ke file |
| Double-click tab | Rename file (inline) |
| Click [x] on tab | Close tab, auto-save dulu |
| Middle-click tab | Close tab |
| Drag tab | Reorder tabs |
| Drag tab out | Detach ke window baru (future) |
| Tab overflow | Scrollable tab bar, shrink tabs |
| Last tab closed | Show welcome screen |

## Sidebar Navigation

| Level | Item | Action |
|-------|------|--------|
| 1 | Folder | Click = expand/collapse |
| 1 | File .md | Click = open di editor |
| 1 | File non-.md | Click = open di OS default |
| 2 | Right-click | Context menu |
| 2 | Drag file | Move to folder |
| 2 | Drag folder | Move folder |

## Command Palette Hierarchy

```
>  (fuzzy search)
├── File
│   ├── Open Vault...
│   ├── New Note
│   ├── Open File...
│   ├── Save
│   ├── Rename
│   └── Delete
├── Edit
│   ├── Undo
│   ├── Redo
│   ├── Find in File
│   └── Replace
├── View
│   ├── Toggle Sidebar
│   ├── Toggle Preview
│   ├── Toggle Fullscreen
│   └── Theme: Dark/Light
├── Navigate
│   ├── Go to Definition (wikilink)
│   ├── Backlinks
│   └── Go to File...
├── Vault
│   ├── Search in Vault...
│   ├── Tags
│   ├── Graph View
│   └── Re-index
├── Git
│   ├── Push to Publish
│   ├── Status
│   └── History
├── AI
│   ├── Ask Assistant
│   ├── Summarize
│   └── Rewrite
└── Help
    ├── About
    ├── Keyboard Shortcuts
    └── Report Issue
```
