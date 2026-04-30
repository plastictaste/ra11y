#!/usr/bin/env bun
// Stop hook. Pre-yield verification sweep. Runs before Claude returns
// control to the user. If typecheck or tests are broken, we block and
// Claude has to fix before the turn ends.
//
// Skip-fast path: when the working tree is clean AND HEAD's tree-sha
// matches the marker written after the last successful Stop run OR by
// pre-commit after a successful verify on the staged tree, the previous
// verify result still holds and we skip. The marker is per-worktree
// (lives under `git rev-parse --git-dir`) so parallel agent worktrees
// stay isolated; see lib/verify-marker.ts for the full rationale and
// the cherry-pick / rebase / amend cases the marker covers.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { audit } from "./lib/audit.ts";
import { readHookInput } from "./lib/input.ts";
import { block, ok } from "./lib/output.ts";
import { interpretTestRun } from "./lib/test-output.ts";
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
  audit({ event: "Stop", action: "skip:already-verified", detail: { tree: skip.tree } });
  ok();
}

const failures: string[] = [];

const SPAWN_OPTS = {
  cwd: projectDir,
  shell: true,
  encoding: "utf8" as const,
  maxBuffer: 64 * 1024 * 1024,
};

// Incremental tsc with a cached buildinfo file (same path scripts/verify.ts
// uses for --precommit). Cold cost ~3s; warm cost ~300ms. Skip is the
// common case anyway; this only matters when the marker is missing or
// the tree changed without going through pre-commit.
const TSBUILDINFO = join(projectDir, "node_modules/.cache/ra11y/tsbuildinfo");
const tsc = spawnSync(
  `bunx tsc --noEmit --incremental --tsBuildInfoFile ${TSBUILDINFO}`,
  SPAWN_OPTS,
);
if (tsc.status !== 0) {
  const out = `${(tsc.stdout ?? "").trim()}\n${(tsc.stderr ?? "").trim()}`.trim();
  failures.push(`tsc --noEmit failed:\n${out}`);
}

const test = spawnSync("bun test --bail", SPAWN_OPTS);
const verdict = interpretTestRun({
  status: test.status,
  stdout: test.stdout ?? "",
  stderr: test.stderr ?? "",
});
if (verdict.failed) {
  // `bun test` exits non-zero for actual test failures AND for transient
  // teardown noise (e.g. an MCP integration test's child process logging
  // `[ra11y error] MCP dispatch error: ...` on shutdown), so trusting the
  // exit code alone misclassifies otherwise-green runs as failures and
  // dumps thousands of lines back to the user. interpretTestRun parses
  // the bun summary's `N fail` line first; the exit code is only the
  // fallback when no summary is present (true crash before any test ran).
  //
  // `(pass)` lines also get dropped inside interpretTestRun — bun emits
  // them to stderr (not stdout), which is why filtering only stdout was
  // a no-op on the original c6cdcba7 patch. See lib/test-output.ts for
  // the full rationale.
  failures.push(`bun test failed:\n${verdict.output}`);
}

if (failures.length > 0) {
  audit({ event: "Stop", action: "block", detail: { failureCount: failures.length } });
  block(
    `Stop hook: verification failed before yielding control. Fix these before the turn ends:\n\n${failures.join("\n\n")}`,
  );
}

// Verify passed — record HEAD's tree-sha as last-verified so subsequent
// Stop runs on an unchanged tree can fast-skip. Only update on success:
// a failed verify must re-run on the next Stop event even if the tree
// hasn't changed.
if (skip.markerPath && skip.tree) {
  writeMarker(skip.markerPath, skip.tree);
}

audit({ event: "Stop", action: "allow" });
ok();
