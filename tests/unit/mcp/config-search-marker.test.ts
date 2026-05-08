/**
 * Unit tests for `src/mcp/config-search-marker.ts` — the walk-up probe
 * that gates the `no_config_found` warning per
 * Q-SHARED-NO-CONFIG-WARNING-TINY-REPO.
 *
 * Invariants:
 *   - A `package.json` at the starting directory returns true.
 *   - A `package.json` at an ancestor directory (within the walk) returns true.
 *   - No marker along the walk returns false.
 *   - A `.git` directory at any walked dir stops the walk and returns false.
 *   - A `ra11y.config.*` file is recognized as a marker (belt-and-suspenders
 *     for the rare case of a config-dotfiles-only tree — matches the
 *     loader's CONFIG_FILENAMES set).
 */

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  nearestConfigAncestorPath,
  sawProjectMarkerInWalk,
} from "../../../src/mcp/config-search-marker.ts";
import { posixJoin } from "../../helpers/path.ts";

function makeTmpDir(prefix: string): Promise<string> {
  return mkdtemp(posixJoin(tmpdir(), `${prefix}-`));
}

describe("sawProjectMarkerInWalk", () => {
  it("returns true when a package.json sits at the starting directory", async () => {
    const dir = await makeTmpDir("ra11y-marker-direct");
    await writeFile(posixJoin(dir, "package.json"), "{}");
    expect(sawProjectMarkerInWalk(dir)).toBe(true);
  });

  it("returns true when a package.json sits at an ancestor directory (walk-up)", async () => {
    const root = await makeTmpDir("ra11y-marker-ancestor");
    await writeFile(posixJoin(root, "package.json"), "{}");
    const nested = posixJoin(root, "a", "b", "c");
    await mkdir(nested, { recursive: true });
    expect(sawProjectMarkerInWalk(nested)).toBe(true);
  });

  it("returns false when no marker exists anywhere in the walk (scratch directory)", async () => {
    // mkdtemp under tmpdir() is a scratch dir; to avoid the system's
    // tmp root itself carrying a package.json, we walk from a nested
    // subdirectory and rely on the `.git`/root stop condition inside
    // tmpdir(). In practice systems don't put a package.json at /tmp,
    // but in case they do this test would spuriously fail — the
    // stronger guard is the `.git`-stop test below which is
    // deterministic.
    const root = await makeTmpDir("ra11y-marker-none");
    const nested = posixJoin(root, "a", "b", "c");
    await mkdir(nested, { recursive: true });
    // Drop a `.git` DIR at the scratch root so the walk stops there
    // rather than continuing into tmpdir() (which might incidentally
    // carry a package.json on some systems). The `.git` stop mirrors
    // the loader's walk-up semantics exactly.
    await mkdir(posixJoin(root, ".git"));
    expect(sawProjectMarkerInWalk(nested)).toBe(false);
  });

  it("stops at a `.git` directory mid-walk — a deeper marker is NOT seen when .git is between the start and it", async () => {
    // The loader's walkUpFrom stops at `.git`; the probe mirrors
    // that semantics so a positive-probe result corresponds
    // one-to-one with "the loader's walk could have found a config
    // here." A package.json above a .git boundary would be outside
    // the loader's reach, so the probe must also pretend it's
    // invisible.
    const outer = await makeTmpDir("ra11y-marker-git-stop");
    await writeFile(posixJoin(outer, "package.json"), "{}"); // outside the probe's reach
    const repo = posixJoin(outer, "repo");
    await mkdir(repo);
    await mkdir(posixJoin(repo, ".git"));
    const nested = posixJoin(repo, "src");
    await mkdir(nested);
    expect(sawProjectMarkerInWalk(nested)).toBe(false);
  });

  it("recognizes ra11y.config.ts as a marker even without a package.json (config-dotfiles tree)", async () => {
    const dir = await makeTmpDir("ra11y-marker-configdotfiles");
    await writeFile(posixJoin(dir, "ra11y.config.ts"), "export default {};");
    await mkdir(posixJoin(dir, ".git")); // stop probe at the scratch root
    expect(sawProjectMarkerInWalk(dir)).toBe(true);
  });

  it("returns true when the marker is found at the starting dir even if a `.git` also exists there", async () => {
    // The loader checks marker filenames first, then .git as the
    // stop. If both exist at the same directory, the marker wins —
    // that directory IS the project root.
    const dir = await makeTmpDir("ra11y-marker-plus-git");
    await writeFile(posixJoin(dir, "package.json"), "{}");
    await mkdir(posixJoin(dir, ".git"));
    expect(sawProjectMarkerInWalk(dir)).toBe(true);
  });
});

// probe:
// `nearestConfigAncestorPath` answers "did you mean a parent dir?" by
// resolving the nearest STRICT ancestor with a project marker. Markers
// at `cwd` itself are ignored on purpose — the empty-files-on-a-real-
// project shape is the normal case for an empty repo, not a misroot.
describe("nearestConfigAncestorPath", () => {
  it("returns the parent directory when an ancestor carries a `ra11y.config.ts`", async () => {
    const root = await makeTmpDir("ra11y-ancestor-config");
    await writeFile(posixJoin(root, "ra11y.config.ts"), "export default {};");
    await mkdir(posixJoin(root, ".git")); // stop probe at the scratch root
    const nested = posixJoin(root, "src");
    await mkdir(nested);
    expect(nearestConfigAncestorPath(nested)).toBe(root);
  });

  it("returns the nearest ancestor when a `package.json` sits two levels up", async () => {
    const root = await makeTmpDir("ra11y-ancestor-pkg");
    await writeFile(posixJoin(root, "package.json"), "{}");
    await mkdir(posixJoin(root, ".git"));
    const nested = posixJoin(root, "a", "b");
    await mkdir(nested, { recursive: true });
    expect(nearestConfigAncestorPath(nested)).toBe(root);
  });

  it("returns undefined when only the starting dir carries a marker (strict-ancestor semantics)", async () => {
    // A marker AT `cwd` is the normal shape for an empty-but-correct
    // scan target — not evidence the caller pointed at the wrong
    // place. Strict-ancestor semantics means the probe ignores it.
    const dir = await makeTmpDir("ra11y-ancestor-self-only");
    await writeFile(posixJoin(dir, "package.json"), "{}");
    await mkdir(posixJoin(dir, ".git"));
    expect(nearestConfigAncestorPath(dir)).toBeUndefined();
  });

  it("returns undefined when a `.git` directory blocks the walk-up before any marker", async () => {
    // `.git` mirrors the loader's stop condition: a marker outside the
    // repo boundary is invisible to the loader and must be invisible
    // here too.
    const outer = await makeTmpDir("ra11y-ancestor-git-stop");
    await writeFile(posixJoin(outer, "package.json"), "{}"); // outside the probe's reach
    const repo = posixJoin(outer, "repo");
    await mkdir(repo);
    await mkdir(posixJoin(repo, ".git"));
    const nested = posixJoin(repo, "src");
    await mkdir(nested);
    expect(nearestConfigAncestorPath(nested)).toBeUndefined();
  });

  it("returns undefined when no ancestor carries a marker (scratch directory)", async () => {
    const root = await makeTmpDir("ra11y-ancestor-none");
    await mkdir(posixJoin(root, ".git")); // stop probe at the scratch root
    const nested = posixJoin(root, "src");
    await mkdir(nested);
    expect(nearestConfigAncestorPath(nested)).toBeUndefined();
  });
});
