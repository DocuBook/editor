# ADR-003: Preview via Standalone React Bundle

**Status:** Accepted  
**Context:** Preview harus identik dengan output final DocuBook. @docubook/mdx-content adalah React components.  
**Alternatives:** SSR sidecar (Go → Bun), goldmark only, iframe terpisah  
**Decision:** Preview bundle — pre-build React + @docubook/mdx-content menjadi satu file preview.js  
**Rationale:** HTMX tetap murni, React cuma di 1 container (#preview), bundle bisa di-build bareng di monorepo DocuBook, output = final.  
**Consequences:** Bundle ~10MB (mermaid included), di-load sebagai <script> di halaman HTMX. Build via esbuild (frontend/build-preview.cjs) karena @mdx-js/mdx punya deps yang gak kompatibel dengan Vite/Rollup. Output: frontend/public/preview.js.
