#!/usr/bin/env node
/**
 * ACL guard — every Tauri command in `generate_handler!` must have an allow
 * entry in BOTH src-tauri/capabilities/default.json and
 * src-tauri/permissions/default.toml. A new command without an ACL entry is
 * silently blocked on desktop (invoke → "not allowed"), so this fails CI
 * instead of shipping a dead command.
 *
 * Run: node test/check-acl.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lib = readFileSync(join(root, "src-tauri/lib.rs"), "utf8");
const cap = readFileSync(
  join(root, "src-tauri/capabilities/default.json"),
  "utf8",
);
const perm = readFileSync(
  join(root, "src-tauri/permissions/default.toml"),
  "utf8",
);

const start = lib.indexOf("generate_handler![");
if (start === -1) {
  console.error("generate_handler![ not found in src-tauri/lib.rs");
  process.exit(1);
}
const open = start + "generate_handler![".length;
const close = lib.indexOf("]", open);
const cmds = lib
  .slice(open, close)
  .split(",")
  .map((s) => s.trim().split("\n").pop().trim())
  // Handler entries are fully qualified (commands::git::git_branches) —
  // drop the module path so the bare command name can be ACL-matched.
  .map((s) => s.split("::").pop().trim())
  .filter((s) => /^[a-z_]+$/.test(s));

const missing = cmds.filter((c) => {
  const id = "allow-" + c.replace(/_/g, "-");
  return (
    !cap.includes(`"${id}"`) || !perm.includes(`commands.allow = ["${c}"]`)
  );
});

if (missing.length) {
  console.error(
    `ACL missing for ${missing.length} command(s): ${missing.join(", ")}`,
  );
  console.error(
    "Add allow-<dashed> to src-tauri/capabilities/default.json AND the [[permission]] block + [default] list in src-tauri/permissions/default.toml.",
  );
  process.exit(1);
}
console.log(
  `ACL OK — all ${cmds.length} generate_handler commands have allow entries`,
);
