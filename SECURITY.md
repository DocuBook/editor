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

## Security model

**Trust boundary & keys** — the Rust backend (desktop `src-tauri`, web `server/`) is the trust boundary; the webview/browser is untrusted. API keys are backend-only and never sent to the webview (`list_keys` returns provider names only, never key material).

**API-key storage**
- Desktop: macOS Keychain (`security` CLI).
- Web (Docker): `keys.json` in `/data`, mode `0600`. **Plaintext by default**; set the `DB_KEYS_PASSPHRASE` env var to enable AES-256-GCM encryption at rest (key derived from the passphrase via Argon2id, fresh salt per file).
- The passphrase protects the file **at rest only** — the real API key still flows to the provider `Authorization` header per request.
- Migration & guards: a plaintext file auto-migrates to encrypted on first access when the passphrase is set; an encrypted file is **never overwritten** when the passphrase is missing; a wrong passphrase yields an error, never garbage.

**Deployment hardening — decide at first boot**
- `DB_SETUP_TOKEN` — required on public deployments so no one can claim the admin account before you do.
- `DB_KEYS_PASSPHRASE` — set from first boot and keep it in your secret manager; losing it makes stored keys unrecoverable.
- Admin account — create it before exposing the server. "Skip for now — keep open access" is a deliberate, **consent-gated** choice: anyone with the URL gets full access (no login) until an admin exists and login is re-enabled in Settings.

**Other controls** — path-traversal-safe vault paths (`safe_path`), SSRF-guarded AI base URLs (allowlist + loopback only), sanitized AI error messages (no provider/URL leakage), CSP, and a web-only server-side trash (`.trash/` inside the vault — persistent in `/data`, excluded from tree, search, and git staging).

## Supported versions

| Version | Supported |
|---------|-----------|
| v0.1.0-alpha.5 and later | ✅ |
| Earlier alphas | ❌ |
