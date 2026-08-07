#!/bin/sh
set -e
# Self-heal /data ownership regardless of how the volume was created.
# A pre-created empty volume is root-owned (Docker skips image copy-up when
# the volume exists before the container) — fix it here as root, then drop
# to the app user. Idempotent: no-op on a healthy volume.
chown -R docubook:docubook /data 2>/dev/null || true
exec su-exec docubook /app/docubook-server
