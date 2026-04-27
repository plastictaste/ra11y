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
// Worktree isolation is the second load-bearing case: the marker lives
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
  getCurrentHead,
  getMarkerPath,
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

describe("getCurrentHead", () => {
  test("returns the 40-char sha of HEAD", () => {
    const head = getCurrentHead(repo);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  test("returns null when cwd is not a git repo", () => {
    const notRepo = mkdtempSync(join(tmpdir(), "ra11y-not-repo-"));
    cleanups.push(notRepo);
    expect(getCurrentHead(notRepo)).toBeNull();
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
    expect(decision.head).toMatch(/^[0-9a-f]{40}$/);
    expect(decision.markerPath).toBeTruthy();
  });

  test("clean+head-match: marker matches HEAD on a clean tree → skip", () => {
    const head = getCurrentHead(repo);
    const path = getMarkerPath(repo);
    expect(head && path).toBeTruthy();
    if (!(head && path)) return;
    writeMarker(path, head);
    const decision = decideSkip(repo);
    expect(decision.skip).toBe(true);
    expect(decision.reason).toBe("clean+head-match");
  });

  test("head-mismatch: new commit since last verify → no skip", () => {
    const oldHead = getCurrentHead(repo);
    const path = getMarkerPath(repo);
    expect(oldHead && path).toBeTruthy();
    if (!(oldHead && path)) return;
    writeMarker(path, oldHead);
    writeFileSync(join(repo, "second.txt"), "x\n");
    git(repo, "add second.txt");
    git(repo, 'commit -q -m "second"');
    const decision = decideSkip(repo);
    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe("head-mismatch");
  });

  test("dirty-tree (modified tracked) → no skip even when marker matches", () => {
    const head = getCurrentHead(repo);
    const path = getMarkerPath(repo);
    expect(head && path).toBeTruthy();
    if (!(head && path)) return;
    writeMarker(path, head);
    writeFileSync(join(repo, "README.md"), "modified\n");
    const decision = decideSkip(repo);
    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe("dirty-tree");
  });

  test("dirty-tree (untracked file) → no skip even when marker matches (regression)", () => {
    const head = getCurrentHead(repo);
    const path = getMarkerPath(repo);
    expect(head && path).toBeTruthy();
    if (!(head && path)) return;
    writeMarker(path, head);
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

    const wtHead = getCurrentHead(worktreePath);
    const wtMarker = getMarkerPath(worktreePath);
    const mainMarker = getMarkerPath(repo);
    expect(wtHead && wtMarker && mainMarker).toBeTruthy();
    if (!(wtHead && wtMarker && mainMarker)) return;

    // Marker only on main checkout; worktree should still decide "no skip".
    writeMarker(mainMarker, wtHead);
    const wtDecision = decideSkip(worktreePath);
    expect(wtDecision.skip).toBe(false);
    expect(wtDecision.reason).toBe("no-marker");

    // Now write the worktree's own marker → it should skip.
    writeMarker(wtMarker, wtHead);
    const wtDecisionAfter = decideSkip(worktreePath);
    expect(wtDecisionAfter.skip).toBe(true);
    expect(wtDecisionAfter.reason).toBe("clean+head-match");
  });
});
