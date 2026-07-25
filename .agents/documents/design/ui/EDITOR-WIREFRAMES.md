# Screen Wireframes — Editor

## Layout Utama (Zed-like)

```mermaid
flowchart TB
    subgraph Window["Editor Window (1200x800)"]
        TB["Title Bar — Editor | [🌙 Theme] [—] [□] [×]"]
        subgraph Body["Body"]
            SB["Sidebar (w-56)\n┌──────────────┐\n│ Files         │\n│ ├ vault/      │\n│ │ ├ index.md  │\n│ │ ├ docs/     │\n│ │ │ └ api.md  │\n│ │ └ about.md  │\n│ │             │\n│ [+ Open Vault]│\n└──────────────┘"]
            ED["Editor Area\n┌─────────────────────────┐\n│ Tab Bar: [index.md x]  │\n├─────────────────────────┤\n│                         │\n│  # Hello World          │\n│                         │\n│  This is markdown       │\n│  content...             │\n│                         │\n│                         │\n│                         │\n└─────────────────────────┘"]
            PV["Preview Pane\n┌─────────────────────────┐\n│ [Split | Preview | Code]│\n├─────────────────────────┤\n│                         │\n│  # Hello World          │\n│                         │\n│  This is markdown       │\n│  content...             │\n│                         │\n│                         │\n│                         │\n└─────────────────────────┘"]
        end
        ST["Status Bar — main | Ln 1, Col 1 | UTF-8 | Ready"]
    end

    SB --- ED --- PV
```

## Welcome Screen (No Vault)

```mermaid
flowchart TB
    subgraph Welcome["Welcome Screen"]
        direction TB
        LOGO["📝 Editor Logo"]
        TITLE["Editor — Write, Publish, Repeat"]
        SUB["Open a folder to start editing markdown"]
        BTN["[  Open Folder  ]"]
        RECENT["Recent Vaults:\n  ~/docs/project\n  ~/notes/personal"]
    end
```

## Command Palette (Ctrl+P)

```mermaid
flowchart TB
    subgraph CP["Command Palette Overlay"]
        INPUT[">  Search commands..."]
        LIST["Open File...\nSearch in Vault...\nToggle Preview\nOpen Vault...\nTheme: Toggle Dark/Light\nGit: Push to Publish\nAI: Ask Assistant"]
    end
```

## Wikilink Autocomplete Popup

```mermaid
flowchart TB
    subgraph AC["Autocomplete Dropdown"]
        Q["[[docu"]]
        RESULTS["📄 documentasi-api\n📄 docu-json-config\n📄 dokumentasi-user\n+ Create 'docu...'"]
    end
```
