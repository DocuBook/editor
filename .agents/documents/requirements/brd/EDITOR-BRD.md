# Business Requirements Document — Editor

## Business Context
Desktop editor untuk markdown yang menggabungkan kecepatan Zed, manajemen catatan Obsidian, dan layer publishing DocuBook. Satu alat untuk menulis catatan pribadi + dokumentasi project yang bisa di-publish ke static HTML.

## Problem Statement
- Developer documentation writers harus pakai 3+ tools (editor + note-taking + publishing)
- Obsidian kuat di note-taking tapi lemah di publishing
- Zed kuat di performa tapi bukan untuk markdown/docs
- VS Code berat (~300MB) untuk sekedar nulis markdown

## Target Market
- Indie developers & small teams yang butuh docs site
- Technical writers
- Knowledge workers

## Revenue Model
- Open source foundation
- Premium: AI agent credits, private CI/CD, team collaboration

## Success Metrics
| Metric | Target |
|--------|--------|
| Bundle size | <20MB |
| Startup time | <1 detik |
| Preview mismatch | 0% (identik final) |
| Vault support | Multi-vault |
| Platform | macOS 10+ (arm64 + x64) |
