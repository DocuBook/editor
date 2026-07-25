# ADR-004: Flame Build di CI, Bukan di Editor

**Status:** Accepted  
**Context:** @docubook/flame membutuhkan Bun/Node, npm packages, base image, dan git integration untuk build static HTML. Wails app perlu di-build untuk dual-arch macOS (arm64 + x64).  
**Alternatives:** Bundle flame di editor, panggil via exec.Command  
**Decision:** Flame build di CI Cloud — editor hanya git push. Binary editor di-build via GitHub Actions matrix (macos-13 untuk intel, macos-14 untuk apple silicon).  
**Rationale:** Build-heavy process (deps install, compile, optimasi) tidak cocok di desktop app. CI handle base image, caching, versioning, dual-arch build matrix.  
**Consequences:** User perlu git setup. CI pipeline di-create (GitHub Actions) dengan strategy matrix arch. Output: 2 DMG (intel + apple silicon).
