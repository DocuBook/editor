#!/usr/bin/env node
/**
 * release-please config guard.
 *
 * `release-as` is *sticky*: when it is set, release-please proposes that exact
 * version instead of the one computed from commits, and it keeps doing so on
 * every later run. The documented way to cut 1.0.0 is to set it, merge that
 * release PR, then remove it — and the removal is the step that is easy to
 * forget:
 *
 *   release-as: "1.0.0"  →  merge  →  forget to remove
 *   →  every future release PR is pinned to 1.0.0
 *
 * This guard makes that failure loud in CI instead of silent. It fires only
 * when the version in the config has *already shipped*, i.e. when the override
 * has done its job and is now stale. A deliberately-set `release-as` for a
 * version not yet released passes untouched, so the 1.0.0 flow still works.
 *
 * It also checks the two other things that silently break a release:
 *
 *   bootstrap-sha        must exist in git (a typo breaks the first run only)
 *   changelog-sections   every visible type must be one the commit-msg hook allows,
 *                        or commits land in the changelog with no section
 *
 * Run: node test/check-release-config.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const workflow = readFileSync(join(root, ".github/workflows/release-please.yml"), "utf8");

const failures = [];
const warn = (msg) => failures.push(msg);

let config, manifest;
try {
  config = readJson("release-please-config.json");
  manifest = readJson(".release-please-manifest.json");
} catch (err) {
  console.error(`release config guard: cannot read release-please config — ${err.message}`);
  process.exit(1);
}

// --- The types the commit-msg hook accepts, which is the set that can appear.
const ALLOWED_TYPES = new Set([
  "feat", "fix", "chore", "ci", "docs", "perf", "refactor", "test", "security",
]);

// --- 1. release-as must not linger once the version it names has shipped.
const releaseAs = config["release-as"];
if (releaseAs !== undefined) {
  const released = new Set(Object.values(manifest));
  if (released.has(releaseAs)) {
    warn(
      `release-please-config.json: "release-as": "${releaseAs}" is stale — that ` +
        `version is already in .release-please-manifest.json. Remove it, or every ` +
        `future release PR stays pinned to ${releaseAs}.`,
    );
  } else {
    console.log(
      `release config: "release-as": "${releaseAs}" is set and not yet released — ` +
        `accepted (this is the 1.0.0 flow). Remove it after that release merges.`,
    );
  }
}

// --- 2. bootstrap-sha must resolve, or the first run silently does nothing useful.
const bootstrap = config["bootstrap-sha"];
if (bootstrap) {
  try {
    execFileSync("git", ["cat-file", "-e", `${bootstrap}^{commit}`], {
      cwd: root,
      stdio: "pipe",
    });
  } catch {
    warn(
      `release-please-config.json: "bootstrap-sha": "${bootstrap}" is not a commit ` +
        `in this repository. It is only read on the first run, so a typo makes the ` +
        `first release PR cover the wrong range.`,
    );
  }
}

// --- 3. changelog sections must match what commits can actually produce.
const sections = config["changelog-sections"] ?? [];
if (sections.length === 0) {
  warn("release-please-config.json: changelog-sections is empty — the changelog would have no headings");
}
const listed = new Set(sections.map((s) => s.type));
for (const type of listed) {
  if (!ALLOWED_TYPES.has(type)) {
    warn(
      `release-please-config.json: changelog-sections lists "${type}", which the ` +
        `commit-msg hook never allows — the section can never appear.`,
    );
  }
}
for (const type of ALLOWED_TYPES) {
  if (!listed.has(type)) {
    warn(
      `release-please-config.json: changelog-sections is missing "${type}" — ` +
        `${type} commits would land in the changelog with no section (or be dropped).`,
    );
  }
}

// --- 4. A hidden / leading-whitespace section title renders invisibly.
for (const s of sections) {
  if (!s.hidden && (!s.section || !s.section.trim())) {
    warn(`release-please-config.json: section for "${s.type}" has an empty title`);
  }
}

// --- 5. The manifest must agree with the manifests release-please will bump.
const pkg = readJson("package.json").version;
const rootManifest = manifest["."];
if (rootManifest === undefined) {
  warn('.release-please-manifest.json: no "." entry — release-please tracks the root package there');
} else if (rootManifest !== pkg) {
  warn(
    `.release-please-manifest.json: "." is ${rootManifest} but package.json is ${pkg}. ` +
      `release-please computes the next version from the manifest, so they must agree.`,
  );
}

// --- 6. The root package must bump the internal core crate alongside the app
// manifests. It is a workspace-shared dependency (both the desktop app and the
// server compile it in), so leaving it out would let core drift to a version
// that no longer matches the release it shipped with.
const rootPackage = config.packages?.["."];
const extraFiles = rootPackage?.["extra-files"] ?? [];
const coreUpdater = extraFiles.find((f) => f.path === "core/Cargo.toml");
if (!coreUpdater) {
  warn(
    'release-please-config.json: the "." package is missing the core extra-file ' +
      'updater ({ "type": "toml", "path": "core/Cargo.toml", "jsonpath": "$.package.version" }) ' +
      "— core/Cargo.toml would stop tracking the release version.",
  );
} else if (coreUpdater.type !== "toml" || coreUpdater.jsonpath !== "$.package.version") {
  warn(
    `release-please-config.json: the core extra-file updater is ` +
      `${JSON.stringify(coreUpdater)} — expected { "type": "toml", ` +
      `"jsonpath": "$.package.version" } so it rewrites the [package] version.`,
  );
}

// --- 7. The workflow must handle hidden-only pushes, which release-please
// cannot turn into a release candidate even when always-update is enabled.
for (const required of [
  "git fetch origin master",
  "git rebase origin/master",
  "git push --force-with-lease origin \"HEAD:${BRANCH}\"",
]) {
  if (!workflow.includes(required)) {
    warn(`release-please.yml is missing the hidden-push synchronization step: ${required}`);
  }
}

// --- 8. The workflow's lockfile sync must match the pre-push hook's, entry for
// entry. The hook syncs the root package AND the nested `docubook-core`
// dependency entry inside each consumer lock; the workflow must do both.
//
// Missing the nested sync is silent in CI: the version-consistency gate used to
// read only the root entries, so a stale nested `docubook-core` passed lint
// while `cargo check --locked` failed in both consumers. That is exactly the
// drift PR 276 needed a manual fixup for (commit bef7584), so it is asserted
// here instead of trusted to a comment.
const syncStepStart = workflow.indexOf("Sync Cargo.lock root versions");
const ciWorkflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
if (syncStepStart === -1) {
  warn("release-please.yml: no 'Sync Cargo.lock root versions' step — nothing syncs the locks on the release PR");
} else {
  const syncStep = workflow.slice(syncStepStart);
  for (const [name, needle, why] of [
    [
      "the nested core dependency sync in src-tauri/Cargo.lock",
      'set_package_version src-tauri/Cargo.lock docubook-core "$core_v"',
      "core is a path dependency of the desktop app, so its version is recorded a " +
        "second time inside src-tauri/Cargo.lock and must track core/Cargo.toml",
    ],
    [
      "the nested core dependency sync in server/Cargo.lock",
      'set_package_version server/Cargo.lock docubook-core "$core_v"',
      "core is a path dependency of the server, so its version is recorded a second " +
        "time inside server/Cargo.lock and must track core/Cargo.toml",
    ],
  ]) {
    if (!syncStep.includes(needle)) {
      warn(`release-please.yml is missing ${name} — ${why}`);
    }
  }
  // The consumer locks are also synced by the hook; a workflow that syncs fewer
  // of them than the hook leaves a drift only a local push can detect.
  for (const lock of ["src-tauri/Cargo.lock", "server/Cargo.lock"]) {
    if (!syncStep.includes(lock)) {
      warn(`release-please.yml never touches ${lock} — release-please only bumps manifests, so this lock would drift`);
    }
  }
}

// --- 9. The CI version gate must compare the nested entries too, or a release
// PR with a stale nested `docubook-core` stays green (as it did for PR 276)
// and only fails later, on a developer's push.
if (!/grep -A1 'name = "docubook-core"' src-tauri\/Cargo\.lock/.test(ciWorkflow)) {
  warn(
    "ci.yml: the version-consistency check does not compare the nested " +
      "docubook-core entry in src-tauri/Cargo.lock — a stale nested version would " +
      "pass lint while `cargo check --locked` fails",
  );
}
if (!/grep -A1 'name = "docubook-core"' server\/Cargo\.lock/.test(ciWorkflow)) {
  warn(
    "ci.yml: the version-consistency check does not compare the nested " +
      "docubook-core entry in server/Cargo.lock — a stale nested version would " +
      "pass lint while `cargo check --locked` fails",
  );
}

if (failures.length) {
  console.error(`release config guard failed (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    "Fix: update release-please-config.json / .release-please-manifest.json. " +
      "See the Release workflow section of CONTRIBUTING.md.",
  );
  process.exit(1);
}

console.log(
  `release config OK — ${sections.length} sections, ` +
    `bootstrap-sha ${bootstrap ? "resolves" : "(unset)"}, ` +
    `manifest agrees with package.json (${pkg}), core tracks the release version, ` +
    `the workflow synchronizes hidden-only pushes, and both consumer locks are ` +
    `synced (root + nested core) and verified`,
);
