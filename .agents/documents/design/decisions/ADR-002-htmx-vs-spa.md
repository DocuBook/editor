# ADR-002: Pilih HTMX + Alpine.js daripada SPA (React/Vue)

**Status:** Accepted  
**Context:** Frontend editor perlu interaktivitas tapi tidak perlu SPA penuh.  
**Alternatives:** React SPA, Vue SPA, vanilla JS  
**Decision:** HTMX + Alpine.js  
**Rationale:** 70% interaktivitas (navigasi, CRUD, tree) adalah server-driven. HTMX handle HTML-over-wire. Alpine handle client state (sidebar toggle, modal). CodeMirror 6 tetap standalone JS.  
**Consequences:** Preview tetap butuh React bundle (preview.js) untuk render @docubook/mdx-content — tapi React dikurung di 1 komponen.
