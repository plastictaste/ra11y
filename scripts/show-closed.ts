#!/usr/bin/env bun
/**
 * Look up the closing commit for a backlog item by ID.
 *
 *   bun scripts/show-closed.ts EXAMPLE-ID
 *
 * Wraps `git log --grep "Closes: <ID>"` (and `Drops:`) so the lookup
 * is a one-liner. Prints the commit hash, subject, and body — the
 * rationale that used to live inline in `.claude/backlog.md` as the
 * `[x]` body now lives here.
 *
 * Exits 0 when at least one commit matches, 1 when the ID was never
 * closed (it may still be open in `.claude/backlog.md`, or it may
 * never have existed).
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dir ?? process.cwd(), "..");

const id = process.argv[2];
if (!id) {
  console.error("usage: bun scripts/show-closed.ts <ID>");
  console.error("example: bun scripts/show-closed.ts EXAMPLE-ID");
  process.exit(2);
}

if (!/^[A-Z][A-Z0-9]*-[A-Z0-9-]+$/.test(id)) {
  console.error(`✗ '${id}' does not look like a backlog ID (expected SHAPE-LIKE-THIS)`);
  process.exit(2);
}

const pattern = `(Closes|Drops):.*\\b${id}\\b`;
const result = spawnSync(
  "git",
  ["log", "--all", "--extended-regexp", `--grep=${pattern}`, "--format=full"],
  { cwd: ROOT, encoding: "utf8" },
);

if (result.status !== 0) {
  console.error(result.stderr.trim() || "git log failed");
  process.exit(result.status ?? 1);
}

const out = result.stdout.trim();
if (!out) {
  console.log(`no closing commit found for ${id}`);
  console.log(`(it may still be open in .claude/backlog.md, or never have existed)`);
  process.exit(1);
}

console.log(out);
