# Sprint 2: Editor + Preview

**Goal:** CodeMirror 6 terintegrasi + preview.js render @docubook/mdx-content

## Tasks

| Task | Description | Estimate |
|------|-------------|----------|
| S2.1 | CodeMirror 6 setup — markdown mode, theme, keybindings | 4h |
| S2.2 | Editor ↔ Alpine.js binding — onChange sync | 2h |
| S2.3 | Preview bundle: init packages/editor-preview/ | 3h |
| S2.4 | Build preview.js — import @docubook/mdx-content + esbuild | 4h |
| S2.5 | Preview bridge — Alpine.js call React updatePreview() | 2h |

**Definition of Done:**
- [ ] Mengetik di CodeMirror → preview update real-time
- [ ] Preview render Mermaid, CodeBlock, Tabs (mdx-content components)
- [ ] preview.js standalone, loaded via <script>
- [ ] Split pane: editor kiri, preview kanan
