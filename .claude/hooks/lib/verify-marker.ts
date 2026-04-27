// Per-worktree "last successfully verified HEAD" marker for stop.ts.
//
// stop.ts unconditionally re-runs typecheck + tests on every yield, which
// duplicates work after a passing pre-commit and on yields where nothing
// has changed. The marker lets stop.ts skip when (a) the working tree is
// clean and (b) HEAD matches the marker written after the last successful
// Stop run. Skip is correctness-safe: a stale marker only ever causes an
// extra verify, never a false-positive skip.
//
// Marker location: $(git rev-parse --git-dir)/ra11y-last-verify. In a
// linked worktree git returns the per-worktree state dir
// (.git/worktrees/<name>/), so each worktree has an isolated marker —
// parallel agent worktrees do not clobber each other's state. Catches
// every HEAD-moving operation that bypasses the PreToolUse Bash(git
// commit*) filter: cherry-picks, merges, rebases, manual commits.
//
// Clean-tree detection uses `git status --porcelain --untracked-files=all`
// rather than `git diff --quiet` — the latter misses untracked files,
// which would let a freshly-added test fixture or src file slip past the
// skip check.
//
// All probes are best-effort: any git failure returns "do not skip" so
// the hook falls through to a real verify run rather than skipping on
// ambiguous state.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const MARKER_FILENAME = "ra11y-last-verify";
const SHA_HEX_LENGTH = 40;

export function getMarkerPath(cwd: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--git-dir"], { cwd, encoding: "utf8" });
  if (r.status !== 0) return null;
  const gitDir = r.stdout.trim();
  if (!gitDir) return null;
  const absGitDir = isAbsolute(gitDir) ? gitDir : join(cwd, gitDir);
  return join(absGitDir, MARKER_FILENAME);
}

export function getCurrentHead(cwd: string): string | null {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  if (r.status !== 0) return null;
  const head = r.stdout.trim();
  return head.length === SHA_HEX_LENGTH ? head : null;
}

export function isTreeClean(cwd: string): boolean {
  const r = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) return false;
  return r.stdout.trim().length === 0;
}

export function readMarker(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const contents = readFileSync(path, "utf8").trim();
    return contents.length === SHA_HEX_LENGTH ? contents : null;
  } catch {
    return null;
  }
}

export function writeMarker(path: string, sha: string): void {
  try {
    writeFileSync(path, `${sha}\n`, "utf8");
  } catch {
    // Marker write failures are non-fatal — next Stop just re-verifies.
  }
}

export interface SkipDecision {
  readonly skip: boolean;
  readonly reason: "clean+head-match" | "head-mismatch" | "dirty-tree" | "no-marker" | "no-git";
  readonly head: string | null;
  readonly markerPath: string | null;
}

/**
 * Pure decision: should stop.ts skip the verify run? Wraps the probes so
 * the hook stays small and the decision is unit-testable without spawning
 * the hook subprocess.
 */
export function decideSkip(cwd: string): SkipDecision {
  const markerPath = getMarkerPath(cwd);
  const head = getCurrentHead(cwd);
  if (!(markerPath && head)) {
    return { skip: false, reason: "no-git", head, markerPath };
  }
  if (!isTreeClean(cwd)) {
    return { skip: false, reason: "dirty-tree", head, markerPath };
  }
  const lastVerified = readMarker(markerPath);
  if (lastVerified === null) {
    return { skip: false, reason: "no-marker", head, markerPath };
  }
  if (lastVerified !== head) {
    return { skip: false, reason: "head-mismatch", head, markerPath };
  }
  return { skip: true, reason: "clean+head-match", head, markerPath };
}
