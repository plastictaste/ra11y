// Per-worktree "last successfully verified tree" marker for stop.ts and
// pre-commit.ts.
//
// stop.ts re-runs typecheck + tests on every yield. pre-commit.ts already
// runs a strict superset of those checks on every commit. Without
// coordination, the immediate Stop after a passing commit duplicates the
// pre-commit verify (~66s of dead work). The marker lets stop.ts skip
// when (a) the working tree is clean and (b) HEAD's tree-sha matches the
// marker written by either the last successful Stop run OR by pre-commit
// after a successful verify on a staged tree (whose sha is what HEAD's
// tree-sha becomes once the commit lands).
//
// Why tree-sha rather than HEAD-sha: pre-commit needs to write the marker
// BEFORE the commit lands (HEAD doesn't exist yet at pre-commit time),
// but the staged tree's sha is what HEAD's tree-sha will be. Tree-sha
// also correctly handles commit-message amendments and re-author commits
// (same tree, different HEAD) — the verified state is the tree, not the
// commit identity.
//
// Skip is correctness-safe: a stale marker only ever causes an extra
// verify, never a false-positive skip. Pre-commit's verify is a strict
// superset of Stop's checks, so any marker pre-commit writes guarantees
// Stop's checks pass on that tree.
//
// Marker location: $(git rev-parse --git-dir)/ra11y-last-verify. In a
// linked worktree git returns the per-worktree state dir
// (.git/worktrees/<name>/), so each worktree has an isolated marker —
// parallel agent worktrees do not clobber each other's state. Catches
// every tree-changing operation that bypasses pre-commit: cherry-picks,
// merges, rebases, manual commits with --no-verify (which we forbid).
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

/**
 * Returns the tree-sha of HEAD (i.e. `git rev-parse HEAD^{tree}`). Stop
 * compares this against the marker; if equal on a clean tree, the verify
 * step skips. Tree-sha rather than HEAD-sha so pre-commit can predict
 * the post-commit state from `git write-tree` on the index.
 */
export function getCurrentTreeSha(cwd: string): string | null {
  const r = spawnSync("git", ["rev-parse", "HEAD^{tree}"], { cwd, encoding: "utf8" });
  if (r.status !== 0) return null;
  const tree = r.stdout.trim();
  return tree.length === SHA_HEX_LENGTH ? tree : null;
}

/**
 * Returns the tree-sha of the current index (i.e. `git write-tree`).
 * Pre-commit calls this after a successful verify so the immediate Stop
 * after the commit lands can fast-skip — once the commit lands, this
 * sha equals HEAD^{tree}. Side effect: writes a tree object into git's
 * object store, which is cheap and harmless (already done internally
 * by every commit).
 */
export function getStagedTreeSha(cwd: string): string | null {
  const r = spawnSync("git", ["write-tree"], { cwd, encoding: "utf8" });
  if (r.status !== 0) return null;
  const tree = r.stdout.trim();
  return tree.length === SHA_HEX_LENGTH ? tree : null;
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
  readonly reason: "clean+tree-match" | "tree-mismatch" | "dirty-tree" | "no-marker" | "no-git";
  readonly tree: string | null;
  readonly markerPath: string | null;
}

/**
 * Pure decision: should stop.ts skip the verify run? Wraps the probes so
 * the hook stays small and the decision is unit-testable without spawning
 * the hook subprocess.
 */
export function decideSkip(cwd: string): SkipDecision {
  const markerPath = getMarkerPath(cwd);
  const tree = getCurrentTreeSha(cwd);
  if (!(markerPath && tree)) {
    return { skip: false, reason: "no-git", tree, markerPath };
  }
  if (!isTreeClean(cwd)) {
    return { skip: false, reason: "dirty-tree", tree, markerPath };
  }
  const lastVerified = readMarker(markerPath);
  if (lastVerified === null) {
    return { skip: false, reason: "no-marker", tree, markerPath };
  }
  if (lastVerified !== tree) {
    return { skip: false, reason: "tree-mismatch", tree, markerPath };
  }
  return { skip: true, reason: "clean+tree-match", tree, markerPath };
}
