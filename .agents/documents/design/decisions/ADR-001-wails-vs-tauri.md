# ADR-001: Pilih Wails (Go) daripada Tauri (Rust) untuk Desktop Shell

**Status:** Accepted  
**Context:** Editor perlu native desktop shell untuk macOS 10+ (arm64 + x64).  
**Alternatives:** Tauri (Rust), Electron (Node.js), Go HTTP + browser  
**Decision:** Wails v2  
**Rationale:** Go sudah familiar, bundle ~10MB, support macOS 10.13+, native webview tanpa Chromium. Cross-compile untuk arm64 dan x64 via CI.  
**Consequences:** CGO required untuk build, macOS notarization perlu setup. Dual-arch build via GitHub Actions matrix.
