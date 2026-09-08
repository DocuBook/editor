# syntax=docker/dockerfile:1

# DocuBook web — multi-stage: frontend build + Rust server, single runtime image.
# Users never build anything: `docker pull <registry>/docubook/editor` and run.

# ---- frontend (vite) ----
# Frontend output is architecture-independent. BUILDPLATFORM keeps this stage native
# and lets one result feed every target in a local multi-platform build.
FROM --platform=$BUILDPLATFORM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY index.html tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts ./
COPY frontend ./frontend
COPY public ./public
COPY test/unit ./test/unit
COPY test/__fixtures__ ./test/__fixtures__
RUN npm run build

# CI overrides this stage with its prebuilt frontend artifact through a named
# `web-content` context. Local builds use the native `web` stage above.
FROM scratch AS web-content
COPY --from=web /app/dist /

# ---- server (Rust, musl) ----
FROM rust:1.98-alpine AS server
# cmake/clang for aws-lc-rs (reqwest TLS), build-base for ring/cc
RUN apk add --no-cache musl-dev build-base cmake clang git
WORKDIR /src
# Compile dependencies before application sources so ordinary source changes reuse
# the expensive release dependency layer.
COPY server/Cargo.toml server/Cargo.lock ./server/
RUN printf 'fn main() {}\n' > server/main.rs \
    && cd server \
    && cargo build --release --locked \
    && rm main.rs
# Reuse the desktop app's pure modules — the web crate includes them via #[path].
COPY src-tauri/vault ./src-tauri/vault
COPY src-tauri/git ./src-tauri/git
COPY src-tauri/wiki ./src-tauri/wiki
COPY src-tauri/search ./src-tauri/search
COPY src-tauri/agent ./src-tauri/agent
COPY src-tauri/markdown.rs ./src-tauri/markdown.rs
COPY server ./server
RUN touch server/main.rs && cd server && cargo build --release --locked

# ---- runtime ----
FROM alpine:3.21
RUN apk add --no-cache git ca-certificates su-exec \
    && adduser -D -u 1000 docubook
WORKDIR /app
COPY --from=server /src/server/target/release/docubook-server /app/docubook-server
COPY --from=web-content / /app/www
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
# Runtime config (DB_*) is passed via compose/run/panel — only static
# defaults live here; the full variable list is in .env.example.
ENV DATA_DIR=/data WWW_DIR=/app/www PORT=8080
# /data must exist with docubook ownership BEFORE first start: named volumes
# inherit the mount-point ownership, so without this the volume is root-owned
# and config.json/keys.json writes fail (EACCES, os error 13). The entrypoint
# re-chowns at every start as a safety net for pre-created empty volumes.
RUN mkdir -p /data && chown -R docubook:docubook /data
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/api/health" >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
