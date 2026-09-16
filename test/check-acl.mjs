#!/usr/bin/env node
/**
 * ACL + IPC parity guard.
 *
 * `generate_handler!` in src-tauri/lib.rs is the single source of truth for the
 * command surface; every other list is derived from it and checked here:
 *
 *   src-tauri/capabilities/default.json  → `allow-<dashed>` entry
 *   src-tauri/permissions/default.toml   → [default] set + allow block + deny block
 *   server/handlers.rs                   → one dispatch arm per answered command
 *
 * A command without an ACL entry is silently blocked on desktop ("not allowed");
 * one without a dispatch arm fails at runtime as "Unknown command" on web. Both
 * fail CI here instead of shipping a dead command.
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
const handlers = readFileSync(join(root, "server/handlers.rs"), "utf8");
const mainRs = readFileSync(join(root, "server/main.rs"), "utf8");

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
  // drop the module path so the bare command name can be matched.
  .map((s) => s.split("::").pop().trim())
  .filter((s) => /^[a-z_]+$/.test(s));

/** Desktop-only: the web runtime has no counterpart, so the server omits it. */
const DESKTOP_ONLY = new Map([
  ["read_file_binary", "web serves binaries through GET /api/file"],
  ["app_ready_to_close", "graceful-shutdown handshake, desktop window only"],
]);

/** Web-only: server features that do not exist on desktop. */
const WEB_ONLY = new Set([
  "web_vaults",
  "web_vault_root",
  "setup_status",
  "account_get",
  "change_password",
  "config_get",
  "config_set",
]);

/** Answered by a dedicated route instead of the catch-all POST /api/{cmd}. */
const DEDICATED_ROUTES = new Map([["ask_ai", "POST /api/ask_ai (SSE stream)"]]);

const failures = [];
const dashed = (cmd) => "allow-" + cmd.replace(/_/g, "-");

// --- Desktop ACL: capabilities + all three representations in the permission file
const defaultSet = perm.slice(
  perm.indexOf("[default]"),
  perm.indexOf("[[permission]]", perm.indexOf("[default]")) === -1
    ? undefined
    : perm.indexOf("[[permission]]", perm.indexOf("[default]")),
);
for (const cmd of cmds) {
  const id = dashed(cmd);
  if (!cap.includes(`"${id}"`)) {
    failures.push(`capabilities/default.json: missing "${id}" for ${cmd}`);
  }
  if (!defaultSet.includes(`"${id}"`)) {
    failures.push(`permissions/default.toml: missing "${id}" in the [default] set`);
  }
  if (!perm.includes(`commands.allow = ["${cmd}"]`)) {
    failures.push(`permissions/default.toml: missing [[permission]] block for ${cmd}`);
  }
  if (!perm.includes(`identifier = "deny-${cmd.replace(/_/g, "-")}"`)) {
    failures.push(`permissions/default.toml: missing deny-${cmd.replace(/_/g, "-")} block`);
  }
}

// --- Web parity: every desktop command must be answered by the server
const arms = new Set(
  [...handlers.matchAll(/^\s*"([a-z_]+)"\s*=>/gm)].map((m) => m[1]),
);
for (const cmd of cmds) {
  if (DESKTOP_ONLY.has(cmd) || DEDICATED_ROUTES.has(cmd) || arms.has(cmd)) continue;
  failures.push(`server/handlers.rs: no dispatch arm for ${cmd}`);
}
for (const arm of arms) {
  if (!cmds.includes(arm) && !WEB_ONLY.has(arm)) {
    failures.push(`server/handlers.rs: dispatch arm "${arm}" is not a known command`);
  }
}

// --- Exception lists must not rot: stale entries hide a real parity break
for (const cmd of [...DESKTOP_ONLY.keys(), ...DEDICATED_ROUTES.keys()]) {
  if (!cmds.includes(cmd)) {
    failures.push(`exception list: "${cmd}" is no longer a command — remove it`);
  }
  if (arms.has(cmd)) {
    failures.push(`exception list: "${cmd}" now has a dispatch arm — remove the exception`);
  }
}
for (const cmd of WEB_ONLY) {
  if (cmds.includes(cmd)) {
    failures.push(`WEB_ONLY: "${cmd}" is now also a desktop command — remove the exception`);
  }
  if (!arms.has(cmd)) {
    failures.push(`WEB_ONLY: "${cmd}" has no dispatch arm — remove the exception`);
  }
}
for (const [cmd, route] of DEDICATED_ROUTES) {
  if (!mainRs.includes(`/api/${cmd}`)) {
    failures.push(`server/main.rs: no route for ${cmd} (${route})`);
  }
}

if (failures.length) {
  console.error(`ACL/IPC parity failed (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    "Fix: derive the entry from src-tauri/lib.rs generate_handler! and update " +
      "src-tauri/capabilities/default.json, src-tauri/permissions/default.toml, " +
      "and server/handlers.rs together.",
  );
  process.exit(1);
}
console.log(
  `ACL/IPC OK — ${cmds.length} commands: ACL complete in both files, ` +
    `${arms.size} answered by the web dispatch`,
);
