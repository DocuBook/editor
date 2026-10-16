#!/bin/sh
# Resolves the v* release tag for the commit the current run is operating on.
#
# Why this exists (see the RCA for v0.2.0): release-please creates the tag via
# the API *after* the release commit is already on master. GitHub then emits no
# workflow run for the tag — the only run for that SHA carries
# `ref=refs/heads/master`. Any `startsWith(github.ref, 'refs/tags/v')` guard is
# therefore false on the very run that should publish, which silently skipped
# ci.yml's build → release-gate → publish and every tag-only step in docker.yml.
#
# So "is this a release?" is answered from the tag on the commit, not from the
# ref the run happened to start on.
#
# Usage: resolve-release-tag.sh
# Env:   GITHUB_REF, GITHUB_SHA, GITHUB_REPOSITORY, GH_TOKEN  (all standard in Actions)
# Out:   tag=<vX.Y.Z|> as a GITHUB_OUTPUT line (empty tag = not a release)
#
# Both tag kinds work. A lightweight tag's `object` IS the commit; an annotated
# tag's `object` is a tag object carrying the commit sha in its own `object`.
# `git/matching-refs` returns one or the other, so annotated candidates are
# dereferenced through /git/tags/{sha} and compared by commit sha.
set -eu

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"

tag=""

case "${GITHUB_REF:-}" in
  refs/tags/v*)
    # A real tag push names the tag directly — no lookup needed.
    tag="${GITHUB_REF#refs/tags/}"
    ;;
  *)
    # Everything else (the release-please master push) is resolved from the tag
    # pointing at this exact commit. `--paginate` guards against a repo with more
    # v* tags than fit one page.
    refs=$(gh api "repos/${GITHUB_REPOSITORY}/git/matching-refs/tags/v" \
      --paginate --jq '.[] | [.ref, .object.type, .object.sha] | @tsv' 2>/dev/null || true)

    while IFS="$(printf '\t')" read -r ref type sha; do
      [ -n "${ref:-}" ] || continue
      commit_sha="$sha"
      if [ "$type" = "tag" ]; then
        # Annotated: peel the tag object to the commit it points at.
        commit_sha=$(gh api "repos/${GITHUB_REPOSITORY}/git/tags/$sha" --jq '.object.sha' 2>/dev/null || echo "")
      fi
      if [ "$commit_sha" = "$GITHUB_SHA" ]; then
        tag="${ref#refs/tags/}"
        break
      fi
    done <<EOF
$refs
EOF
    ;;
esac

echo "tag=$tag"
if [ -n "$tag" ]; then
  echo "Resolved release tag: $tag" >&2
else
  echo "No v* tag on $GITHUB_SHA — not a release." >&2
fi
