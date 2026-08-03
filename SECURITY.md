# Security Policy

## Reporting a Vulnerability

If you find a security vulnerability in DocuBook, **do not open a public issue**. Report it privately instead:

- **Email:** [email@wildan.dev](mailto:email@wildan.dev)
- **Subject prefix:** `[SECURITY]`

Please include:
- The affected version(s)
- A description of the vulnerability and its impact
- Steps to reproduce (or a minimal PoC)
- Any suggested fix, if you have one

## What happens next

1. You will get an acknowledgement within **48 hours**.
2. The issue is triaged and a fix is prepared (no public disclosure until it ships).
3. Once fixed, we coordinate disclosure — typically with a release note, and credit in the changelog if you wish.

## Scope

The Rust backend (`src-tauri`) is the trust boundary; the webview is treated as untrusted. Reports involving path traversal, SSRF, XSS, key handling, or IPC authorization are especially welcome.

## Supported versions

| Version | Supported |
|---------|-----------|
| v0.1.0-alpha.5 and later | ✅ |
| Earlier alphas | ❌ |
