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
- `DB_SETUP_TOKEN` — optional fixed setup token. If unset, the server prints a one-time token to its log at first boot and the wizard requires it, so no one can claim the admin account before you do. The token changes on restart until the admin exists.
- `DB_KEYS_PASSPHRASE` — set from first boot and keep it in your secret manager; losing it makes stored keys unrecoverable. Without it the server logs a `keys_plaintext` warning at startup.
- `DB_TRUSTED_PROXY` — comma-separated addresses or CIDR ranges of your reverse proxies, for example `127.0.0.1` for a proxy on the same host or `172.18.0.0/16` for a Docker network (a range keeps working when the proxy container gets a new address). Only a listed proxy's `X-Forwarded-For` names the real client for the login rate limit, and the proxy must append to that header rather than pass the client's value through: nginx `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` (Traefik appends by default). Without a listed proxy the forwarded headers are ignored, and any request that passed through a proxy is treated as remote for the setup gate.
  - **Caddy:** list Caddy's address. Nothing else to set; Caddy writes `X-Forwarded-For` and `X-Forwarded-Proto` itself.
  - **Traefik:** list Traefik's address or its Docker network range. Keep the default; do not set `notAppendXForwardedFor`.
  - **nginx:** list nginx and set `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` and `proxy_set_header X-Forwarded-Proto $scheme;`. With only `X-Real-IP` set, the client's own `X-Forwarded-For` is passed through; the server sees the two disagree and falls back to the proxy's address.
  - **Cloudflare:** to rate-limit per visitor, also list Cloudflare's published ranges (https://www.cloudflare.com/ips/). Unlisted, the Cloudflare edge address is used: coarser, but not spoofable. With a Worker in front, list Cloudflare only if the Worker sets `X-Forwarded-For` itself.
  - **HTTPS:** the proxy must send `X-Forwarded-Proto: https` for session cookies to be `Secure`. For an HTTPS-only site, set `DB_SECURE_COOKIE=1` to force it regardless of the proxy.
- Admin account — setup cannot be skipped. Create it before exposing the server; login remains required afterward.

**Other controls** — path-traversal-safe vault paths (`safe_path`), SSRF-guarded AI base URLs (allowlist + loopback only), sanitized AI error messages (no provider/URL leakage), CSP, and a web-only server-side trash (`.trash/` inside the vault — persistent in `/data`, excluded from tree, search, and git staging).

## Supported versions

| Version | Supported |
|---------|-----------|
| v0.1.0-next and later | ✅ |
| Earlier pre-releases | ❌ |
