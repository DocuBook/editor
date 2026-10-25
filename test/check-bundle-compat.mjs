#!/usr/bin/env node
/**
 * Engine-compat guard for the BUILT frontend, against .browserslistrc.
 *
 * The source lint (compat/compat in .oxlintrc.json) only sees our own code,
 * but most past WKWebView regressions shipped from elsewhere: structuredClone
 * inside mermaid, `:has()` / `overflow-clip` from Tailwind classes, a regex
 * lookbehind folded in by the bundler. Those exist only in dist/assets, so
 * this checks what actually ships:
 *
 *   JS  — eslint-plugin-compat via oxlint (test/compat-dist.oxlintrc.json,
 *         which documents the feature-detected APIs it lets through)
 *   CSS — doiuse, failing only on features an engine lacks entirely.
 *         "Partial support" is not checked: caniuse marks hundreds of
 *         ordinary declarations partial, none of them actionable. Known
 *         blind spot: an unsupported VALUE of a supported property, e.g.
 *         `overflow: clip` (Safari 16) is only "partial overflow" — those
 *         still need the manual @supports fallbacks in frontend/index.css.
 *
 * Run: npm run build && node test/check-bundle-compat.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import doiuse from "doiuse";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "dist/assets");
if (!existsSync(assets)) {
  console.error("dist/assets not found — run `npm run build` first.");
  process.exit(1);
}
const files = readdirSync(assets);
const jsFiles = files.filter((f) => f.endsWith(".js")).map((f) => join("dist/assets", f));
const cssFiles = files.filter((f) => f.endsWith(".css")).map((f) => join("dist/assets", f));

/**
 * CSS features an engine lacks but that degrade harmlessly where they appear.
 * Ignored per feature, so review a new usage before relying on this list.
 */
const CSS_IGNORE = {
  // Scroll chaining only (Mantine ScrollArea, TabBar `overscroll-contain`).
  "css-overscroll-behavior": "cosmetic: scroll chaining past the end",
  // No touch input on macOS WKWebView; desktop browsers ignore it the same way.
  "css-touch-action": "no-op without touch input",
  // Mantine layout trims; text simply keeps its default line box.
  "css-text-box-trim": "progressive enhancement",
  // `ui-monospace` is always followed by named and generic fallbacks.
  "extended-system-fonts": "font stack has fallbacks",
  // BlockNote numbered lists store attr() in a custom property and read it
  // back in `content`, where attr() is supported everywhere.
  "css3-attr": "attr() is consumed by `content`",
  // Only Mantine Pagination and AppShell use these; the app renders neither.
  // Our own dvh layout is @supports-gated in frontend/index.css.
  "css-container-queries": "Mantine Pagination only (unused)",
  "viewport-unit-variants": "Mantine AppShell only (unused)",
};

const failures = [];

// --- JS -------------------------------------------------------------------
const oxlint = spawnSync(
  join(root, "node_modules/.bin/oxlint"),
  ["-c", "test/compat-dist.oxlintrc.json", "--no-ignore", "--format", "json", ...jsFiles],
  { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
let report;
try {
  report = JSON.parse(oxlint.stdout);
} catch {
  console.error(`oxlint did not return a JSON report:\n${oxlint.stderr || oxlint.stdout}`);
  process.exit(1);
}

/** eslint-plugin-compat flags any regex literal containing `?<=` / `?<!`,
 *  even escaped (langium matches the text "(?<=" to detect lookarounds).
 *  A real lookbehind group is an unescaped `(?<=` / `(?<!` outside a
 *  character class — that one is a SyntaxError on Safari < 16.4 and must
 *  still fail. */
function hasRealLookbehind(literal) {
  const pattern = literal.slice(1, literal.lastIndexOf("/"));
  const stripped = pattern.replace(/\\./g, "").replace(/\[[^\]]*\]/g, "");
  return /\(\?<[=!]/.test(stripped);
}

const sources = new Map();
let jsCount = 0;
for (const d of report.diagnostics) {
  const span = d.labels?.[0]?.span;
  if (d.message.startsWith("Lookbehind ") && span) {
    if (!sources.has(d.filename)) sources.set(d.filename, readFileSync(join(root, d.filename), "utf8"));
    const literal = sources.get(d.filename).slice(span.offset, span.offset + span.length);
    if (!hasRealLookbehind(literal)) continue;
  }
  jsCount++;
  failures.push(`JS  ${d.filename}:${span?.line}:${span?.column} — ${d.message}`);
}

// --- CSS ------------------------------------------------------------------
const ignoredSeen = new Set();
let cssCount = 0;
for (const file of cssFiles) {
  const css = readFileSync(join(root, file), "utf8");
  await postcss([
    doiuse({
      onFeatureUsage(usage) {
        // Partial support only: not checked (see header).
        if (!usage.featureData.missing) return;
        if (usage.feature in CSS_IGNORE) {
          ignoredSeen.add(usage.feature);
          return;
        }
        cssCount++;
        const at = usage.usage?.source?.start;
        failures.push(
          `CSS ${file}:${at?.line}:${at?.column} — ${usage.featureData.title} ` +
            `(${usage.feature}) missing in ${usage.featureData.missing}`,
        );
      },
    }),
  ]).process(css, { from: join(root, file) }); // `from` makes browserslist find .browserslistrc
}

const stale = Object.keys(CSS_IGNORE).filter((f) => !ignoredSeen.has(f));

if (failures.length) {
  console.error(`Bundle compat failed (${jsCount} JS, ${cssCount} CSS) against .browserslistrc:`);
  for (const failure of failures.slice(0, 50)) console.error(`  - ${failure}`);
  if (failures.length > 50) console.error(`  … and ${failures.length - 50} more`);
  console.error(
    "Fix: avoid the API/feature, guard it at runtime, or polyfill it in frontend/main.tsx. " +
      "If a dependency already guards it, add it to test/compat-dist.oxlintrc.json (JS) " +
      "or CSS_IGNORE in this file, with the reason.",
  );
  process.exit(1);
}
if (stale.length) {
  console.log(`Note: CSS_IGNORE entries no longer used — consider removing: ${stale.join(", ")}`);
}
const targets =
  process.env.BROWSERSLIST ??
  readFileSync(join(root, ".browserslistrc"), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .join(", ");
console.log(`Bundle compat OK — ${jsFiles.length} JS + ${cssFiles.length} CSS files run on: ${targets}`);
