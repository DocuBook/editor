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
    `manifest agrees with package.json (${pkg})`,
);
