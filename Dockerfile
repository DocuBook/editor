# DocuBook web — multi-stage: frontend build + Rust server, single runtime image.
# Users never build anything: `docker pull <registry>/docubook/editor` and run.

# ---- frontend (vite) ----
FROM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- server (Rust, musl) ----
FROM rust:1.94-alpine AS server
# cmake/clang for aws-lc-rs (reqwest TLS), build-base for ring/cc
RUN apk add --no-cache musl-dev build-base cmake clang git
WORKDIR /src
# Reuse the desktop app's pure modules — the web crate includes them via #[path].
COPY src-tauri/vault ./src-tauri/vault
COPY src-tauri/git ./src-tauri/git
COPY src-tauri/wiki ./src-tauri/wiki
COPY src-tauri/search ./src-tauri/search
COPY src-tauri/agent ./src-tauri/agent
COPY server ./server
RUN cd server && cargo build --release

# ---- runtime ----
FROM alpine:3.21
RUN apk add --no-cache git ca-certificates \
    && adduser -D -u 1000 docubook
WORKDIR /app
COPY --from=server /src/server/target/release/docubook-server /app/docubook-server
COPY --from=web /app/dist /app/www
ENV DATA_DIR=/data WWW_DIR=/app/www PORT=8080
# /data must exist with docubook ownership BEFORE the USER switch: named
# volumes inherit the mount-point ownership, so without this the volume is
# root-owned and config.json/keys.json writes fail (EACCES, os error 13).
RUN mkdir -p /data && chown -R docubook:docubook /data
USER docubook
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1
ENTRYPOINT ["/app/docubook-server"]
