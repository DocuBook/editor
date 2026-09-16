#!/usr/bin/env node
/**
 * Container packaging guard.
 *
 * The web server reuses the desktop app's pure modules through
 * `#[path = "../src-tauri/…"]` includes, but the Dockerfile copies only the
 * paths it knows about. A new include therefore breaks `docker build` with
 * "couldn't read ../src-tauri/…" while every local cargo command still passes.
 *
 * Both directions are checked, so the copy list can neither miss an include nor
 * keep a stale one:
 *
 *   server/**\/*.rs  #[path = "../src-tauri/<p>"]  →  Dockerfile COPY src-tauri/<p>
 *   Dockerfile COPY src-tauri/<p>                  →  some #[path] include
 *
 * Run: node test/check-docker-paths.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");

const serverDir = join(root, "server");
const sources = readdirSync(serverDir)
  .filter((name) => name.endsWith(".rs"))
  .map((name) => readFileSync(join(serverDir, name), "utf8"))
  .join("\n");

/** `../src-tauri/git/mod.rs` → `src-tauri/git` (the directory holding the module). */
const included = new Set();
for (const match of sources.matchAll(/#\[path = "\.\.\/(src-tauri\/[^"]+)"\]/g)) {
  const parts = match[1].split("/");
  // A `mod.rs` (or a bare file like markdown.rs) is addressed by its parent path.
  const path = parts[parts.length - 1] === "mod.rs"
    ? parts.slice(0, -1).join("/")
    : parts.join("/");
  included.add(path);
}

const copied = new Set(
  [...dockerfile.matchAll(/^COPY\s+(src-tauri\/\S+)/gm)].map((m) => m[1]),
);

const failures = [];
for (const path of included) {
  if (!copied.has(path)) {
    failures.push(`Dockerfile: no "COPY ${path}" for the #[path] include in server/`);
  }
}
for (const path of copied) {
  if (!included.has(path)) {
    failures.push(`Dockerfile: "COPY ${path}" is stale — no server #[path] include uses it`);
  }
}

if (failures.length) {
  console.error(`Container packaging failed (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    "Fix: keep the Dockerfile src-tauri COPY lines and the #[path] includes in " +
      "server/ in sync.",
  );
  process.exit(1);
}
console.log(
  `Docker paths OK — ${included.size} shared src-tauri paths copied and used`,
);
