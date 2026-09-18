#!/bin/sh
# Verifies an image honours the /data mount contract on any Docker host.
#
# Usage: smoke-test.sh <image-ref> [platform]
#
# Cases:
#   1. named volume, root start            -> healthy, /data writable as uid 1000
#   2. dedicated bind dir, root start      -> healthy, /data writable as uid 1000
#   3. bind dir with foreign nested files  -> nested ownership left untouched
#   4. named volume, --user docubook       -> healthy without any root repair
#   5. unwritable bind dir, --user docubook -> fail fast, actionable message
#
# Case 3 is the regression guard for the incident where a bind of a shared host
# parent (holding a co-located platform's data) was recursively chowned.
# Case 3 creates a foreign-owned directory, so it needs root; CI runs the
# suite with sudo to keep that regression guard active. A non-root caller
# still gets the other four cases.
set -eu

image="$1"
platform="${2:-}"
name="docubook-smoke-$$"
volume="${name}-data"
port=18080
bind_dirs=""

cleanup() {
  docker rm --force "$name" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  for dir in $bind_dirs; do
    # The container chowns a bind mount root to uid 1000. A non-root caller
    # cannot delete that from a sticky /tmp, and a failing command inside an
    # EXIT trap would turn a passing run into a non-zero exit.
    rm -rf "$dir" 2>/dev/null || true
  done
  return 0
}
trap cleanup EXIT

platform_flag=""
[ -n "$platform" ] && platform_flag="--platform=$platform"

fail() {
  echo "smoke-test: $1" >&2
  exit 1
}

wait_ready() {
  attempt=1
  while [ "$attempt" -le 30 ]; do
    if curl --fail --silent "http://127.0.0.1:${port}/api/health" >/dev/null; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  docker logs "$name" >&2 || true
  fail "server did not become healthy on port ${port}"
}

# start <mount> [extra docker run flags...]
start() {
  mount="$1"
  shift
  docker volume rm "$volume" >/dev/null 2>&1 || true
  docker volume create "$volume" >/dev/null
  docker run --detach --name "$name" $platform_flag \
    --env DB_SETUP_TOKEN=ci-smoke-token \
    --volume "$mount" \
    --publish "${port}:8080" \
    "$@" "$image" >/dev/null
  wait_ready
}

stop() {
  docker rm --force "$name" >/dev/null
}

writable_as_docubook() {
  docker exec --user docubook "$name" sh -c 'touch "$1/.probe" && rm "$1/.probe"' sh /data
}

echo "smoke-test: 1/5 named volume, root start"
start "${volume}:/data"
curl --fail --silent "http://127.0.0.1:${port}/" >/dev/null
writable_as_docubook || fail "named volume is not writable as uid 1000"
stop

echo "smoke-test: 2/5 dedicated bind directory, root start"
bind_dir="$(mktemp -d)"
bind_dirs="$bind_dirs $bind_dir"
start "${bind_dir}:/data"
writable_as_docubook || fail "dedicated bind directory is not writable as uid 1000"
stop

echo "smoke-test: 3/5 bind mount must not chown nested host files"
if [ "$(id -u)" = "0" ]; then
  bind_dir="$(mktemp -d)"
  bind_dirs="$bind_dirs $bind_dir"
  mkdir -p "$bind_dir/another-app"
  chown 9999:9999 "$bind_dir/another-app"
  chmod 700 "$bind_dir/another-app"
  start "${bind_dir}:/data"
  nested="$(stat -c '%u:%g' "$bind_dir/another-app")"
  stop
  [ "$nested" = "9999:9999" ] \
    || fail "bind mount recursively chowned nested host files (now $nested)"
else
  echo "smoke-test: 3/5 skipped (needs root to create foreign ownership)"
fi

echo "smoke-test: 4/5 named volume, non-root start"
start "${volume}:/data" --user docubook
writable_as_docubook || fail "named volume is not writable as uid 1000 without root"
stop

echo "smoke-test: 5/5 unwritable bind directory, non-root start fails fast"
bind_dir="$(mktemp -d)"
bind_dirs="$bind_dirs $bind_dir"
chmod 700 "$bind_dir"
set +e
output=$(docker run $platform_flag --rm --name "$name" \
  --user docubook \
  --env DB_SETUP_TOKEN=ci-smoke-token \
  --volume "${bind_dir}:/data" \
  "$image" 2>&1)
status=$?
set -e
[ "$status" -ne 0 ] || fail "expected non-root start on an unwritable bind mount to fail"
echo "$output" | grep -q "not writable" \
  || fail "expected an actionable 'not writable' message, got: $output"

echo "smoke-test: ok"
