#!/bin/sh
set -e

# /data ownership contract.
#
# DocuBook writes config.json, keys.json, sessions.json and vaults/ as uid 1000.
# The image ships /data owned by 1000:1000, and Docker seeds an EMPTY named
# volume from that image directory, so the common case needs no repair at all.
#
# A bind mount is different: it keeps the host directory's ownership, so a chown
# here rewrites ownership of host files. That is how a bind of host /data once
# chowned a co-located platform's (Coolify's) storage and broke its deploys.
# Repair therefore depends on what backs DATA_DIR:
#   - Docker named volume -> app-owned, safe to repair recursively
#   - bind mount          -> the mount root only, never its contents
#   - no mount            -> image-owned, nothing to do
# Unrecognised layouts fall back to the bind-mount behaviour (the safe one).
#
# Finally the mount must be writable as uid 1000; otherwise fail fast instead of
# starting a server that dies later with EACCES (os error 13). A startup warning
# flags an anonymous volume, whose data disappears on recreate.

DATA_DIR="${DATA_DIR:-/data}"
if [ "$DATA_DIR" != "/" ]; then
  DATA_DIR="${DATA_DIR%/}"
fi
APP_USER=docubook
APP_BIN=/app/docubook-server

# mountinfo field 4 is the mount's subtree root: the host path Docker grafted
# onto the mount point in field 5. (In /proc/mounts the equivalent first field
# is the backing device, which cannot tell a volume from a bind mount.)
mount_root=$(awk -v dir="$DATA_DIR" '$5 == dir { print $4; exit }' /proc/self/mountinfo)

repair_ownership() {
  case "$mount_root" in
    */volumes/*/_data)
      # Docker-managed volume: exclusively owned by this app.
      chown -R "$APP_USER:$APP_USER" "$DATA_DIR" 2>/dev/null || true
      ;;
    '')
      # No mount: the image already owns this path.
      ;;
    *)
      # Host bind mount: only the mount root. Recursing would rewrite ownership
      # of host files this app does not own (e.g. a shared parent directory).
      chown "$APP_USER:$APP_USER" "$DATA_DIR" 2>/dev/null || true
      printf '%s\n' \
        "docubook: $DATA_DIR is a bind mount; only the mount root was chowned." \
        "DocuBook needs a DEDICATED host directory owned by 1000:1000;" \
        "never bind a shared parent such as /data, \$HOME or another app's dir." >&2
      ;;
  esac
}

# Probe as the app user. Runs through sh so no `test` binary needs to be on PATH.
writable_as_app_user() {
  su-exec "$APP_USER" sh -c 'test -w "$1"' sh "$DATA_DIR"
}

# Docker names anonymous volumes with a 64-hex id. `VOLUME /data` makes Docker
# create one whenever no mount is given, and it is NOT reused after `docker rm`,
# so the vaults silently disappear on recreate while the old volume lingers.
warn_if_anonymous_volume() {
  case "$mount_root" in
    */volumes/*/_data) ;;
    *) return 0 ;;
  esac
  volume_name=$(basename "$(dirname "$mount_root")")
  [ "${#volume_name}" = 64 ] || return 0
  [ -z "$(printf '%s' "$volume_name" | tr -d '0-9a-f')" ] || return 0
  printf '%s\n' \
    "docubook: $DATA_DIR is an anonymous Docker volume ($volume_name)." \
    "It is not reused after \`docker rm\`, so vaults look lost on recreate." \
    "Mount a named volume instead: docker run -v docubook:/data ..." >&2
}

warn_if_anonymous_volume

if [ "$(id -u)" = "0" ]; then
  repair_ownership
  if ! writable_as_app_user; then
    printf '%s\n' \
      "docubook: $DATA_DIR is not writable by uid 1000." \
      "Use a Docker named volume, or chown the dedicated host directory to 1000:1000:" \
      "  chown -R 1000:1000 <host-dir>" >&2
    exit 1
  fi
  exec su-exec "$APP_USER" "$APP_BIN"
fi

if ! test -w "$DATA_DIR"; then
  printf '%s\n' \
    "docubook: $DATA_DIR is not writable by the current user (uid $(id -u))." \
    "Run as root (the default) so the entrypoint can repair a volume, or give" \
    "this uid ownership of the dedicated mount directory." >&2
  exit 1
fi

exec "$APP_BIN"
