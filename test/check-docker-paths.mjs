#!/usr/bin/env node
/**
 * Container packaging guard.
 *
 * The web server no longer reaches into the desktop app through
 * `#[path = "../src-tauri/…"]` includes: the shared engine lives in the `core/`
 * crate, which both runtimes depend on by path. Because the Dockerfile copies
 * only what it knows about, a server that silently re-introduced such an include
 * — or a Dockerfile that forgot to package `core/` — would break `docker build`
 * while every local cargo command still passes. Both failure modes are checked,
 * so the image can never drift from the crate layout.
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

const failures = [];

// Shared modules must stay in the `core` crate. A `../src-tauri/…` include would
// escape this package (breaking rust-analyzer) and silently re-tie the image to
// a hand-maintained COPY list.
for (const match of sources.matchAll(/#\[path = "\.\.\/src-tauri\/[^"]+"\]/g)) {
  failures.push(
    `server/: ${match[0]} reaches into src-tauri — move the module into core/ and depend on it`,
  );
}

// The image must package the shared crate: its manifest for the dependency-cache
// resolve step, and its sources for the final build.
for (const required of ["core/Cargo.toml", "core "]) {
  if (!dockerfile.includes(`COPY ${required}`)) {
    failures.push(`Dockerfile: missing "COPY ${required.trim()}" for the core crate`);
  }
}

if (failures.length) {
  console.error(`Container packaging failed (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  "Docker paths OK — core crate is packaged and no server source escapes into src-tauri",
);
