// Unit tests for the stop-hook skip-fast marker. These exercise the pure
// decision functions against real temp git repos rather than spawning the
// hook subprocess — the verify spawn (tsc + bun test) is not the
// interesting part to test, the marker decision logic is.
//
// The most load-bearing case is the untracked-file regression: an earlier
// design used `git diff --quiet` for clean-tree detection, which silently
// misses untracked files. A new src/ or test/ file slipping past the skip
// would let stop.ts return "everything verified" while a file the verify
// would have caught sits on disk. The "dirty-tree-untracked" case below
// pins the `git status --porcelain --untracked-files=all` choice.
//
// The second load-bearing case is the pre-commit handoff: pre-commit.ts
// writes the staged tree-sha (from `git write-tree`) to the marker after
// a successful verify; once the commit lands, HEAD^{tree} equals that
// sha and Stop can fast-skip. The "pre-commit handoff" case below pins
// that the staged tree-sha equals the post-commit HEAD^{tree}.
//
// Worktree isolation is the third load-bearing case: the marker lives
// under `git rev-parse --git-dir`, which returns a per-worktree path in
// linked worktrees. That keeps parallel agent worktrees from clobbering
// each other's "last verified" state.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideSkip,
  getCurrentTreeSha,
  getMarkerPath,
  getStagedTreeSha,
  isTreeClean,
  MARKER_FILENAME,
  readMarker,
  writeMarker,
} from "../../.claude/hooks/lib/verify-marker.ts";

let repo: string;
const cleanups: string[] = [];

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ra11y-stop-hook-"));
  cleanups.push(dir);
  git(dir, "init -q -b main");
  git(dir, 'config user.email "test@example.com"');
  git(dir, 'config user.name "Test"');
  writeFileSync(join(dir, "README.md"), "init\n");
  git(dir, "add README.md");
  git(dir, 'commit -q -m "init"');
  return dir;
}

beforeEach(() => {
  repo = makeRepo();
});

afterEach(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("getMarkerPath", () => {
  test("returns absolute path under .git for main checkout", () => {
    const path = getMarkerPath(repo);
    expect(path).toBeTruthy();
    expect(path?.endsWith(`/${MARKER_FILENAME}`)).toBe(true);
    expect(path?.includes("/.git/")).toBe(true);
  });

  test("returns null when cwd is not a git repo", () => {
    const notRepo = mkdtempSync(join(tmpdir(), "ra11y-not-repo-"));
    cleanups.push(notRepo);
    expect(getMarkerPath(notRepo)).toBeNull();
  });
});

describe("getCurrentTreeSha", () => {
  test("returns the 40-char tree-sha of HEAD", () => {
    const tree = getCurrentTreeSha(repo);
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
  });

  test("differs from the HEAD-sha (regression: tree-sha, not commit-sha)", () => {
    const tree = getCurrentTreeSha(repo);
    const head = git(repo, "rev-parse HEAD").trim();
    expect(tree).not.toBe(head);
  });

  test("returns null when cwd is not a git repo", () => {
    const notRepo = mkdtempSync(join(tmpdir(), "ra11y-not-repo-"));
    cleanups.push(notRepo);
    expect(getCurrentTreeSha(notRepo)).toBeNull();
  });
});

describe("getStagedTreeSha", () => {
  test("returns a 40-char tree-sha for the index", () => {
    const tree = getStagedTreeSha(repo);
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
  });

  test("equals HEAD's tree when nothing is staged or modified", () => {
    expect(getStagedTreeSha(repo)).toBe(getCurrentTreeSha(repo));
  });

  test("equals post-commit HEAD^{tree} (pre-commit handoff invariant)", () => {
    writeFileSync(join(repo, "file.txt"), "hello\n");
    git(repo, "add file.txt");
    const stagedBefore = getStagedTreeSha(repo);
    git(repo, 'commit -q -m "add file"');
    const treeAfter = getCurrentTreeSha(repo);
    expect(stagedBefore).toBe(treeAfter);
  });

  test("returns null when cwd is not a git repo", () => {
    const notRepo = mkdtempSync(join(tmpdir(), "ra11y-not-repo-"));
    cleanups.push(notRepo);
    expect(getStagedTreeSha(notRepo)).toBeNull();
  });
});

describe("isTreeClean", () => {
  test("true on a freshly committed tree", () => {
    expect(isTreeClean(repo)).toBe(true);
  });

  test("false when a tracked file is modified", () => {
    writeFileSync(join(repo, "README.md"), "modified\n");
    expect(isTreeClean(repo)).toBe(false);
  });

  test("false when a file is staged but not committed", () => {
    writeFileSync(join(repo, "staged.txt"), "x\n");
    git(repo, "add staged.txt");
    expect(isTreeClean(repo)).toBe(false);
  });

  test("false when an untracked file exists (regression: diff --quiet would miss this)", () => {
    writeFileSync(join(repo, "untracked.txt"), "x\n");
    expect(isTreeClean(repo)).toBe(false);
  });
});

describe("readMarker / writeMarker round-trip", () => {
  test("write then read returns the same sha", () => {
    const path = getMarkerPath(repo);
    expect(path).toBeTruthy();
    if (!path) return;
    const sha = "a".repeat(40);
    writeMarker(path, sha);
    expect(readMarker(path)).toBe(sha);
  });

  test("readMarker returns null when file is absent", () => {
    const path = getMarkerPath(repo);
    expect(path).toBeTruthy();
    if (!path) return;
    expect(readMarker(path)).toBeNull();
  });

  test("readMarker returns null when contents are not a 40-char sha", () => {
    const path = getMarkerPath(repo);
    expect(path).toBeTruthy();
    if (!path) return;
    writeFileSync(path, "garbage\n");
    expect(readMarker(path)).toBeNull();
  });
});

describe("decideSkip", () => {
  test("no-marker: first run, never verified", () => {
    const decision = decideSkip(repo);
    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe("no-marker");
    expect(decision.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(decision.markerPath).toBeTruthy();
  });

  test("clean+tree-match: marker matches HEAD's tree on a clean tree → skip", () => {
    const tree = getCurrentTreeSha(repo);
    const path = getMarkerPath(repo);
    expect(tree && path).toBeTruthy();
    if (!(tree && path)) return;
    writeMarker(path, tree);
    const decision = decideSkip(repo);
    expect(decision.skip).toBe(true);
    expect(decision.reason).toBe("clean+tree-match");
  });

  test("tree-mismatch: new commit since last verify → no skip", () => {
    const oldTree = getCurrentTreeSha(repo);
    const path = getMarkerPath(repo);
    expect(oldTree && path).toBeTruthy();
    if (!(oldTree && path)) return;
    writeMarker(path, oldTree);
    writeFileSync(join(repo, "second.txt"), "x\n");
    git(repo, "add second.txt");
    git(repo, 'commit -q -m "second"');
    const decision = decideSkip(repo);
    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe("tree-mismatch");
  });

  test("amend with same content → tree unchanged → still skips", () => {
    // Tree-sha (not HEAD-sha) means amending the commit message on an
    // already-verified tree doesn't force a needless reverify.
    const tree = getCurrentTreeSha(repo);
    const path = getMarkerPath(repo);
    expect(tree && path).toBeTruthy();
    if (!(tree && path)) return;
    writeMarker(path, tree);
    git(repo, 'commit -q --amend -m "init reworded"');
    const decision = decideSkip(repo);
    expect(decision.skip).toBe(true);
    expect(decision.reason).toBe("clean+tree-match");
  });

  test("pre-commit handoff: staged tree-sha written before commit fast-skips after commit", () => {
    // Simulates pre-commit.ts writing the staged tree-sha after a
    // successful verify, then the commit landing, then Stop firing.
    const path = getMarkerPath(repo);
    expect(path).toBeTruthy();
    if (!path) return;
    writeFileSync(join(repo, "feature.txt"), "x\n");
    git(repo, "add feature.txt");
    const stagedTree = getStagedTreeSha(repo);
    expect(stagedTree).toBeTruthy();
    if (!stagedTree) return;
    writeMarker(path, stagedTree);
    git(repo, 'commit -q -m "feat"');
    const decision = decideSkip(repo);
    expect(decision.skip).toBe(true);
    expect(decision.reason).toBe("clean+tree-match");
  });

  test("dirty-tree (modified tracked) → no skip even when marker matches", () => {
    const tree = getCurrentTreeSha(repo);
    const path = getMarkerPath(repo);
    expect(tree && path).toBeTruthy();
    if (!(tree && path)) return;
    writeMarker(path, tree);
    writeFileSync(join(repo, "README.md"), "modified\n");
    const decision = decideSkip(repo);
    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe("dirty-tree");
  });

  test("dirty-tree (untracked file) → no skip even when marker matches (regression)", () => {
    const tree = getCurrentTreeSha(repo);
    const path = getMarkerPath(repo);
    expect(tree && path).toBeTruthy();
    if (!(tree && path)) return;
    writeMarker(path, tree);
    writeFileSync(join(repo, "new-fixture.ts"), "export const x = 1;\n");
    const decision = decideSkip(repo);
    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe("dirty-tree");
  });
});

describe("worktree isolation", () => {
  test("linked worktree's marker is independent of main checkout's marker", () => {
    const worktreePath = join(repo, "..", `wt-${Date.now()}`);
    cleanups.push(worktreePath);
    git(repo, `worktree add -q -b feature-branch "${worktreePath}"`);

    const mainPath = getMarkerPath(repo);
    const wtPath = getMarkerPath(worktreePath);
    expect(mainPath).toBeTruthy();
    expect(wtPath).toBeTruthy();
    if (!(mainPath && wtPath)) return;

    expect(mainPath).not.toBe(wtPath);
    // Linked worktree marker lives under .git/worktrees/<name>/
    expect(wtPath.includes("/.git/worktrees/")).toBe(true);
    // Main checkout marker is the bare .git/ dir.
    expect(mainPath.includes("/.git/worktrees/")).toBe(false);

    // Write to the worktree marker; main marker stays absent.
    writeMarker(wtPath, "b".repeat(40));
    expect(readMarker(wtPath)).toBe("b".repeat(40));
    expect(readMarker(mainPath)).toBeNull();

    // Write a different sha to main; worktree marker is untouched.
    writeMarker(mainPath, "c".repeat(40));
    expect(readMarker(mainPath)).toBe("c".repeat(40));
    expect(readMarker(wtPath)).toBe("b".repeat(40));
  });

  test("linked worktree decideSkip uses its own marker, not main's", () => {
    const worktreePath = join(repo, "..", `wt-${Date.now()}-decide`);
    cleanups.push(worktreePath);
    git(repo, `worktree add -q -b feature-decide "${worktreePath}"`);

    const wtTree = getCurrentTreeSha(worktreePath);
    const wtMarker = getMarkerPath(worktreePath);
    const mainMarker = getMarkerPath(repo);
    expect(wtTree && wtMarker && mainMarker).toBeTruthy();
    if (!(wtTree && wtMarker && mainMarker)) return;

    // Marker only on main checkout; worktree should still decide "no skip".
    writeMarker(mainMarker, wtTree);
    const wtDecision = decideSkip(worktreePath);
    expect(wtDecision.skip).toBe(false);
    expect(wtDecision.reason).toBe("no-marker");

    // Now write the worktree's own marker → it should skip.
    writeMarker(wtMarker, wtTree);
    const wtDecisionAfter = decideSkip(worktreePath);
    expect(wtDecisionAfter.skip).toBe(true);
    expect(wtDecisionAfter.reason).toBe("clean+tree-match");
  });
});
