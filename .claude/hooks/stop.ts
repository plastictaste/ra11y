#!/usr/bin/env bun
// Stop hook. Pre-yield verification sweep. Runs before Claude returns
// control to the user. If typecheck or tests are broken, we block and
// Claude has to fix before the turn ends.
//
// Skip-fast path: when the working tree is clean AND HEAD matches the
// marker written after the last successful Stop run, the previous verify
// result still holds and we skip. The marker is per-worktree (lives under
// `git rev-parse --git-dir`) so parallel agent worktrees stay isolated;
// see lib/verify-marker.ts for the full rationale and the cherry-pick /
// rebase / manual-commit cases the marker covers.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { audit } from "./lib/audit.ts";
import { readHookInput } from "./lib/input.ts";
import { block, ok } from "./lib/output.ts";
import type { StopInput } from "./lib/types.ts";
import { decideSkip, writeMarker } from "./lib/verify-marker.ts";

const input = await readHookInput<StopInput>();
const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd;

// Only run if there's something to check.
const hasSrc = existsSync(join(projectDir, "src"));
const hasNodeModules = existsSync(join(projectDir, "node_modules"));
if (!(hasSrc && hasNodeModules)) {
  audit({ event: "Stop", action: "skip:no-src-or-node-modules" });
  ok();
}

const skip = decideSkip(projectDir);
if (skip.skip) {
  audit({ event: "Stop", action: "skip:already-verified", detail: { head: skip.head } });
  ok();
}

const failures: string[] = [];

const SPAWN_OPTS = {
  cwd: projectDir,
  shell: true,
  encoding: "utf8" as const,
  maxBuffer: 64 * 1024 * 1024,
};

const tsc = spawnSync("bunx tsc --noEmit", SPAWN_OPTS);
if (tsc.status !== 0) {
  const out = `${(tsc.stdout ?? "").trim()}\n${(tsc.stderr ?? "").trim()}`.trim();
  failures.push(`tsc --noEmit failed:\n${out}`);
}

const test = spawnSync("bun test --bail", SPAWN_OPTS);
if (test.status !== 0) {
  // Drop verbose `(pass)` lines on failure — bun test prints every passing
  // test by default, which floods the bounded hook-feedback channel
  // (~5000 lines on a full suite). Keep file headers, fail lines, error
  // stacks, and the trailing summary block.
  const stdoutFiltered = (test.stdout ?? "")
    .split("\n")
    .filter((line) => !line.startsWith("(pass)"))
    .join("\n")
    .trim();
  const out = `${stdoutFiltered}\n${(test.stderr ?? "").trim()}`.trim();
  failures.push(`bun test failed:\n${out}`);
}

if (failures.length > 0) {
  audit({ event: "Stop", action: "block", detail: { failureCount: failures.length } });
  block(
    `Stop hook: verification failed before yielding control. Fix these before the turn ends:\n\n${failures.join("\n\n")}`,
  );
}

// Verify passed — record HEAD as last-verified so subsequent Stop runs
// on an unchanged tree can fast-skip. Only update on success: a failed
// verify must re-run on the next Stop event even if the tree hasn't
// changed.
if (skip.markerPath && skip.head) {
  writeMarker(skip.markerPath, skip.head);
}

audit({ event: "Stop", action: "allow" });
ok();
