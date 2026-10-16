#!/usr/bin/env node
/**
 * Release-tag guard.
 *
 * Regression guard for the v0.2.0 incident: release-please creates the tag via
 * the API *after* the release commit is already on master, so GitHub emits no
 * run for the tag — the only run for that SHA carries `ref=refs/heads/master`.
 *
 * A guard written as `startsWith(github.ref, 'refs/tags/v')` is therefore false
 * on the one run that should publish, and the failure is *silent*: the jobs
 * report `skipped`, the tag technically matches, and the release simply ships
 * with no DMGs and no image. That is exactly what happened — ci.yml's publish
 * and docker.yml's tag-only steps both skipped.
 *
 * Two things are checked here:
 *
 *   1. No workflow gates a publishing step on `startsWith(github.ref, ...tags)`
 *      or `github.ref_name` for the release decision. Release detection must go
 *      through .github/scripts/resolve-release-tag.sh, which looks the tag up on
 *      the commit and handles both push shapes.
 *   2. That resolver actually resolves a tagged commit and rejects an untagged
 *      one — the logic is exercised against a stubbed `gh`, so this runs offline.
 *   3. A publish job never treats "this run is not a release" as a fatal error.
 *      The v0.2.0 fix made `build` run on every master push, which exposed a
 *      second, latent bug: `publish` was gated on the event/ref heuristic
 *      (`github.event_name == 'push' && github.ref_type == 'branch'`), which is
 *      true for EVERY master push, release or not. So an ordinary master push
 *      entered `publish` and then hard-failed in a step that ran
 *      `resolve-release-tag.sh` and `exit 1`-ed on an empty tag, painting master
 *      red for a non-release. Publishing must SKIP when there is no tag — the
 *      same way ci.yml's `release-gate` and docker.yml's `resolve-tag` behave.
 *
 * Run: node test/check-release-tag.mjs
 */
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const fail = (msg) => failures.push(msg)

const RESOLVER = '.github/scripts/resolve-release-tag.sh'

// --- 1. No workflow may decide "is a release" from github.ref / github.ref_name
//
// `github.ref_type == 'branch'` is allowed as the *eligibility* half of the
// condition (it lets the run proceed so the resolver can look the tag up), but
// the publish decision itself must come from the resolver's output.
const workflowDir = join(root, '.github/workflows')
for (const file of readdirSync(workflowDir).filter((f) => f.endsWith('.yml'))) {
  const src = readFileSync(join(workflowDir, file), 'utf8')
  const lines = src.split('\n')
  lines.forEach((line, i) => {
    const isIf = /^\s*(if:|- if:|if: \|)/.test(line)
    const inlineTagGuard = /startsWith\(\s*github\.ref\s*,\s*['"]refs\/tags/.test(line)
    if (isIf && inlineTagGuard && !/github\.ref_type/.test(line)) {
      // A bare tag-ref check is the bug. It is fine only when paired with the
      // branch case, which the resolver then disambiguates.
      fail(
        `.github/workflows/${file}:${i + 1} gates on startsWith(github.ref, 'refs/tags') without ` +
          `an accompanying branch case — this is the v0.2.0 bug (job silently skips on the ` +
          `release-please master push). Use ${RESOLVER} instead.`,
      )
    }
  })

  // Publishing steps must consult the resolver output, not the run's ref.
  if (/gh release create/.test(src) && !/resolve-release-tag\.sh/.test(src)) {
    fail(
      `.github/workflows/${file} creates a release but never calls ${RESOLVER} — the tag it ` +
        `publishes under would be derived from github.ref, which is a branch on release-please runs.`,
    )
  }
}

// --- 2. Exercise the resolver against a stubbed `gh` (offline, deterministic)
const resolverPath = join(root, RESOLVER)
try {
  readFileSync(resolverPath)
} catch {
  fail(`${RESOLVER} is missing — the release decision has no single source of truth.`)
}

if (!failures.length) {
  const workdir = mkdtempSync(join(tmpdir(), 'resolve-tag-'))
  const fakeBin = join(workdir, 'bin')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(fakeBin, { recursive: true })

  // Stub `gh` so the paginated `--jq` output is fixed regardless of network.
  // Three refs: a lightweight tag on TARGET, an annotated tag object, and an
  // unrelated tag — the resolver must pick the lightweight one.
  const TARGET = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  // NB: real tab separators (\t in printf format), and tabs inserted via
  // printf so the fields line up with the resolver's IFS tab read.
  const stub = `#!/bin/sh
args="$*"
case "$args" in
  *"matching-refs/tags/v"*)
    printf 'refs/tags/v1.0.0\\tcommit\\t%s\\n' '${TARGET}'
    printf 'refs/tags/v1.1.0\\tcommit\\t%s\\n' 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    printf 'refs/tags/v2.0.0\\ttag\\t%s\\n' 'cccccccccccccccccccccccccccccccccccccccc'
    ;;
  *"git/tags/"*)
    # Peeled commit of the annotated tag: not the target, so it must not match.
    printf '%s\\n' 'dddddddddddddddddddddddddddddddddddddddd'
    ;;
  *) exit 1 ;;
esac
`
  writeFileSync(join(fakeBin, 'gh'), stub)
  chmodSync(join(fakeBin, 'gh'), 0o755)

  const run = (env) =>
    spawnSync('sh', [resolverPath], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, ...env },
    })

  const base = { GITHUB_REPOSITORY: 'o/r' }

  const tagged = run({ ...base, GITHUB_SHA: TARGET, GITHUB_REF: 'refs/heads/master' })
  if (!/^tag=v1\.0\.0$/m.test(tagged.stdout)) {
    fail(
      `resolver did not find the lightweight tag on a master push ` +
        `(stdout=${JSON.stringify(tagged.stdout.trim())}, stderr=${JSON.stringify(tagged.stderr.trim())})`,
    )
  }

  const untagged = run({ ...base, GITHUB_SHA: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', GITHUB_REF: 'refs/heads/master' })
  if (!/^tag=$/m.test(untagged.stdout)) {
    fail(
      `resolver claimed a tag on an untagged commit ` +
        `(stdout=${JSON.stringify(untagged.stdout.trim())})`,
    )
  }

  const push = run({ ...base, GITHUB_SHA: TARGET, GITHUB_REF: 'refs/tags/v1.0.0' })
  if (!/^tag=v1\.0\.0$/m.test(push.stdout)) {
    fail(`resolver did not pass through an explicit tag push (stdout=${JSON.stringify(push.stdout.trim())})`)
  }

  rmSync(workdir, { recursive: true, force: true })
}

// --- 3. A publish job must skip on a non-release, never hard-fail on one.
//
// The distractor: `github.event_name == 'push' && github.ref_type == 'branch'`
// reads like a release check but matches every master push. What matters is that
// the job's own `if:` keys off the resolved tag, so the job is never *entered*
// on a non-release. The old shape entered it and `exit 1`-ed inside — the failure
// users actually saw.
const ciSrc = readFileSync(join(workflowDir, 'ci.yml'), 'utf8')
const ciLines = ciSrc.split('\n')

// Slice one top-level job (2-space indent) out of the workflow text.
const jobBody = (name) => {
  const at = ciLines.findIndex((l) => new RegExp(`^\\s{2}${name}:\\s*$`).test(l))
  if (at === -1) return null
  let out = ''
  for (let i = at + 1; i < ciLines.length; i++) {
    if (/^\s{2}[a-z][a-z0-9-]*:\s*$/.test(ciLines[i])) break // next job
    out += ciLines[i] + '\n'
  }
  return out
}

const publishBody = jobBody('publish')
if (publishBody === null) {
  fail('.github/workflows/ci.yml: no `publish:` job — the release would ship no artifacts')
} else {
  // The job's `if:` may be folded (`if: >-`) across several lines; take it whole.
  const ifMatch = publishBody.match(/(^|\n)\s{4}if:\s*(>-|\|)?\s*\n?([\s\S]*?)(?=\n\s{4}[a-z]|$)/)
  const ifText = ifMatch ? ifMatch[3] : ''

  if (!/outputs\.tag\s*!=\s*''/.test(ifText)) {
    fail(
      `.github/workflows/ci.yml: the \`publish\` job's \`if:\` does not require a resolved ` +
        `non-empty tag (\`needs.release-gate.outputs.tag != ''\`). Without it the job is entered ` +
        `on an ordinary master push — the event/ref heuristic matches every push to the branch — ` +
        `and then fails there ("refusing to publish") instead of skipping. ` +
        `Got: ${JSON.stringify(ifText.trim())}`,
    )
  }

  // The exact hard-fail that turned a non-release push into a red master.
  if (/refusing to publish/.test(ciSrc)) {
    fail(
      '.github/workflows/ci.yml: still contains "refusing to publish" — the publish job must ' +
        'skip when there is no tag on the commit, not error out. An ordinary master push is a ' +
        'non-release, not a failure.',
    )
  }

  // release-gate must expose the tag, or publish has nothing sound to gate on.
  const gateBody = jobBody('release-gate')
  if (gateBody === null) {
    fail('.github/workflows/ci.yml: no `release-gate:` job — nothing resolves the tag for publish')
  } else if (!/outputs:\s*\n\s{6}tag:\s*\$\{\{\s*steps\.releasetag\.outputs\.tag\s*\}\}/.test(gateBody)) {
    fail(
      '.github/workflows/ci.yml: `release-gate` does not publish its resolved tag as a job ' +
        'output (`outputs.tag: ${{ steps.releasetag.outputs.tag }}`), so `publish` cannot gate on it',
    )
  }
}

if (failures.length) {
  console.error('Release-tag guard FAILED:\n')
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}

console.log(
  'Release-tag guard OK — no workflow decides a release from github.ref, the resolver ' +
    'finds a lightweight tag on a master push, passes through a tag push, and rejects an untagged ' +
    'commit, and publish skips (never fails) on a non-release push',
)
