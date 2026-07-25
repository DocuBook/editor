# Domain Model — Editor

```mermaid
erDiagram
    Vault ||--o{ Note : contains
    Vault ||--o{ Tag : has
    Note ||--o{ Wikilink : references
    Note ||--o{ TagAssignment : tagged
    Tag ||--o{ TagAssignment : assigned
    Note ||--o{ Backlink : has

    Vault {
        string path PK
        string name
        datetime openedAt
        boolean isProject "has docu.json"
    }

    Note {
        string path PK
        string title "from frontmatter or filename"
        string content "markdown"
        datetime createdAt
        datetime updatedAt
        string frontmatter "YAML"
        int wordCount
    }

    Tag {
        string name PK
        string color
    }

    TagAssignment {
        string notePath FK
        string tagName FK
    }

    Wikilink {
        string sourcePath FK
        string targetPath FK
        string alias "display text"
    }

    Backlink {
        string notePath FK
        string referencedBy FK
    }
```

## Entities

### Vault
Root directory yang berisi file markdown. Bisa pribadi (tanpa docu.json) atau project (ada docu.json).

### Note
Satu file markdown (.md) di dalam vault. Punya frontmatter YAML opsional, konten markdown, dan metadata.

### Tag
Label yang bisa ditempel ke note — inline `#tag` atau di frontmatter `tags: [tag1, tag2]`.

### Wikilink
Referensi `[[Note Title]]` dari satu note ke note lain. Autocomplete saat ngetik `[[`.

### Backlink
Link balik — note mana saja yang me-refer ke note ini.

## State Machine — Note

```mermaid
stateDiagram-v2
    [*] --> Draft : create file
    Draft --> Published : git push
    Draft --> Archived : move to archive/
    Published --> Draft : edit after push
    Published --> Archived
    Archived --> Draft : restore
```
