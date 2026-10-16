#!/usr/bin/env node
/**
 * Release changelog-heading guard.
 *
 * `release-please.yml`'s "Normalise the changelog heading" step rewrites the
 * heading release-please generates into this repo's `## vX.Y.Z — YYYY-MM-DD`
 * dialect, because `ci.yml`'s version-consistency gate keys on the `v` prefix.
 * The step lives inside a workflow heredoc, so nothing else can exercise it —
 * and that is exactly how it broke:
 *
 *   release-please emitted   ## [0.2.0](…/compare/…) (2026-10-16)   ← `github`
 *   the step matched         ## 0.2.0 (                        ← `default`
 *   no match → it `exit 0`-ed with "nothing to do"
 *   → the raw heading shipped → ci.yml rejected it with
 *     "CHANGELOG.md missing section '## v0.2.0'"
 *
 * The release PR then carried a green lockfile sync and a failed lint gate.
 * This guard extracts the pattern from the workflow itself — so it cannot drift
 * from what actually runs — and asserts it against both dialects plus the
 * near-misses that must NOT match.
 *
 * Run: node test/check-changelog-heading.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(join(root, ".github/workflows/release-please.yml"), "utf8");

const failures = [];
const fail = (msg) => failures.push(msg);

// --- Rebuild the step's regex from the workflow source verbatim.
// The step defines `escaped` then `heading`; mirror both expressions so a change
// in the workflow is picked up here rather than silently diverging.
const stepStart = workflow.indexOf("Normalise the changelog heading");
if (stepStart === -1) {
  fail(
    "release-please.yml: no 'Normalise the changelog heading' step — the heading " +
      "would reach ci.yml un-normalised and fail the version gate",
  );
} else {
  const step = workflow.slice(stepStart);
  // The two fragments are joined with `+` in the heredoc. Pull them out of the
  // backtick-delimited template literals — the second starts with `|^##`.
  const patterns = [...step.matchAll(/`(\|?\^##[^`]*)`/g)].map((m) => m[1]);
  if (patterns.length !== 2) {
    fail(
      `release-please.yml: expected 2 heading pattern fragments in the normalise step, ` +
        `found ${patterns.length} — this guard needs updating alongside the step`,
    );
  } else {
    // The heredoc body has YAML-safe doubled backslashes; a real Node template
    // literal only ever has one. `${escaped}` is the step's own placeholder for
    // the regex-escaped version, so substitute it the same way the step does.
    const VERSION = "0.2.0";
    const escapedVersion = VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const source = patterns
      .join("")
      .replace(/\\\\/g, "\\")
      .replace(/\$\{escaped\}/g, escapedVersion);
    const re = new RegExp(source);

    const must = [
      ["github dialect", "## [0.2.0](https://github.com/DocuBook/editor/compare/v0.1.8...v0.2.0) (2026-10-16)"],
      ["default dialect", "## 0.2.0 (2026-10-16)"],
      ["already normalised (em dash)", "## v0.2.0 — 2026-10-16"],
      ["already normalised (hyphen)", "## v0.2.0 - 2026-10-16"],
    ];
    const mustNot = [
      ["a different version", "## v0.1.8 — 2026-10-03"],
      ["a longer version", "## 0.2.01 (2026-10-16)"],
      ["a prerelease of this version", "## 0.2.0-rc.1 (2026-10-16)"],
      ["an h3 heading", "### 0.2.0 (2026-10-16)"],
    ];

    for (const [label, line] of must) {
      if (!re.test(line)) fail(`normalise pattern misses ${label}: ${JSON.stringify(line)}`);
    }
    for (const [label, line] of mustNot) {
      if (re.test(line)) fail(`normalise pattern wrongly matches ${label}: ${JSON.stringify(line)}`);
    }

    // The dialect that actually bit us must yield a usable date, or the rewrite
    // silently substitutes today's date and mislabels the section.
    const github = "## [0.2.0](https://x/y(compare)...) (2026-10-16)";
    const m = github.match(re);
    const date = m && (m[1] || m[2]);
    if (date !== "2026-10-16") {
      fail(
        `normalise pattern did not capture the date from the github dialect ` +
          `(got ${JSON.stringify(date ?? null)}, want "2026-10-16") — the rewritten ` +
          `heading would carry the wrong date`,
      );
    }

    // Re-running the step on its own output must be a no-op, or a second
    // workflow run would rewrite an already-correct heading.
    const normalised = `## v${VERSION} — 2026-10-16`;
    if (!re.test(normalised)) {
      fail(`normalise pattern is not idempotent — it does not match its own output ${JSON.stringify(normalised)}`);
    }
  }

  // The step must fail loudly. The original bug was a silent `exit 0`.
  if (!/no changelog heading for/.test(step)) {
    fail(
      "release-please.yml: the normalise step no longer fails loudly when no heading " +
        "matches — a silent no-op is how an un-normalised changelog reached CI",
    );
  }
}

// --- The gate must accept the normalised form, or the rewrite is pointless.
// The gate is `grep -E` with `$npm_v` interpolated; test it with 0.2.0 substituted.
const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
const gateLine = ci.split("\n").find((l) => l.includes("grep -qE") && l.includes("^## v"));
if (!gateLine) {
  fail("ci.yml: could not find the changelog section gate pattern");
} else {
  const pattern = gateLine
    .replace(/.*grep -qE "/, "")
    .replace(/".*/, "")
    .replace(/\$npm_v/g, "0\.2\.0");
  if (!pattern.startsWith("^## v")) {
    fail(`ci.yml: could not parse the gate pattern out of ${JSON.stringify(gateLine.trim())}`);
  } else {
    const gateRe = new RegExp(pattern);
    for (const line of ["## v0.2.0 — 2026-10-16", "## v0.2.0 (2026-10-16)"]) {
      if (!gateRe.test(line)) {
        fail(`ci.yml gate rejects the normalised heading: ${JSON.stringify(line)}`);
      }
    }
  }
}

if (failures.length) {
  console.error(`changelog heading guard failed (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  "Changelog heading OK — normalise step matches both release-please dialects, " +
    "rejects near-misses, keeps the date, and fails loudly",
);
