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
import { join } from "node:path";
import { sawProjectMarkerInWalk } from "../../../src/mcp/config-search-marker.ts";

function makeTmpDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
}

describe("sawProjectMarkerInWalk", () => {
  it("returns true when a package.json sits at the starting directory", async () => {
    const dir = await makeTmpDir("ra11y-marker-direct");
    await writeFile(join(dir, "package.json"), "{}");
    expect(sawProjectMarkerInWalk(dir)).toBe(true);
  });

  it("returns true when a package.json sits at an ancestor directory (walk-up)", async () => {
    const root = await makeTmpDir("ra11y-marker-ancestor");
    await writeFile(join(root, "package.json"), "{}");
    const nested = join(root, "a", "b", "c");
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
    const nested = join(root, "a", "b", "c");
    await mkdir(nested, { recursive: true });
    // Drop a `.git` DIR at the scratch root so the walk stops there
    // rather than continuing into tmpdir() (which might incidentally
    // carry a package.json on some systems). The `.git` stop mirrors
    // the loader's walk-up semantics exactly.
    await mkdir(join(root, ".git"));
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
    await writeFile(join(outer, "package.json"), "{}"); // outside the probe's reach
    const repo = join(outer, "repo");
    await mkdir(repo);
    await mkdir(join(repo, ".git"));
    const nested = join(repo, "src");
    await mkdir(nested);
    expect(sawProjectMarkerInWalk(nested)).toBe(false);
  });

  it("recognizes ra11y.config.ts as a marker even without a package.json (config-dotfiles tree)", async () => {
    const dir = await makeTmpDir("ra11y-marker-configdotfiles");
    await writeFile(join(dir, "ra11y.config.ts"), "export default {};");
    await mkdir(join(dir, ".git")); // stop probe at the scratch root
    expect(sawProjectMarkerInWalk(dir)).toBe(true);
  });

  it("returns true when the marker is found at the starting dir even if a `.git` also exists there", async () => {
    // The loader checks marker filenames first, then .git as the
    // stop. If both exist at the same directory, the marker wins —
    // that directory IS the project root.
    const dir = await makeTmpDir("ra11y-marker-plus-git");
    await writeFile(join(dir, "package.json"), "{}");
    await mkdir(join(dir, ".git"));
    expect(sawProjectMarkerInWalk(dir)).toBe(true);
  });
});
