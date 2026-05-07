/**
 * Path-list adapter for the slim-envelope's narrowing-dir picker on
 * surfaces that don't carry the formatted `{ path, findings }` shape
 * `pickNonVendorNarrowingDir` expects — `checklist` and `coverage`,
 * where the slim envelope needs the same scope-down pivot but the
 * response carries `ParsedFile[]` (paths only) rather than the
 * per-file findings tally.
 *
 * Lives in its own file (rather than inside `scan-project-budget.ts`)
 * so the latter stays under the 500-effective-line budget enforced
 * by `scripts/check-limits.ts`. The helper is structurally identical
 * to {@link import("./scan-project-budget.ts").pickNonVendorNarrowingDir}
 * but takes a flat path list — see that helper's docblock for the
 * shared design rationale.
 */

import { posix } from "node:path";

/**
 * Picks the dominant non-vendor top-level directory from a flat list
 * of root-relative POSIX paths.
 *
 * Same semantics as the formatted-files variant in
 * `scan-project-budget.ts`: weights by file count (each file
 * contributes 1), excludes vendor-classified paths, returns
 * `undefined` when no non-vendor file exists, every file resolves to
 * a single root directory equal to `.`, or the top-dir tally ties at
 * the top. The tie semantics are honest per the AI-first doctrine —
 * naming an alphabetical winner would route the agent to a dir that
 * doesn't actually dominate, the same failure mode the "NextStep
 * prioritization on truncated/bulk responses must avoid first-by-
 * filename routing" bullet warns against.
 *
 * The unit-weighted tally is honest because the narrowing target is
 * "where authored work lives," not "where the findings cluster" —
 * both surfaces' slim recovery is "re-call with a narrower scope so
 * the per-criterion / per-rule detail comes back," and the dominant
 * authored sub-tree is the right pivot regardless of per-file finding
 * density.
 */
export function pickNonVendorNarrowingDirFromPaths(
  relativePaths: readonly string[],
  isVendor: (path: string) => boolean,
): string | undefined {
  const dirCounts = new Map<string, number>();
  for (const path of relativePaths) {
    if (isVendor(path)) continue;
    const topDir = topLevelDir(path);
    if (topDir === undefined) continue;
    dirCounts.set(topDir, (dirCounts.get(topDir) ?? 0) + 1);
  }
  if (dirCounts.size === 0) return undefined;
  let topDir: string | undefined;
  let topCount = 0;
  let tie = false;
  for (const [dir, count] of dirCounts) {
    if (count > topCount) {
      topDir = dir;
      topCount = count;
      tie = false;
    } else if (count === topCount) {
      tie = true;
    }
  }
  return tie ? undefined : topDir;
}

/**
 * Returns the first path segment of a relative POSIX path (e.g. `src`
 * for `src/foo/bar.tsx`), or `undefined` when the path has no slash
 * (root file — narrowing to `.` would be a no-op) or is empty.
 *
 * Mirrors the private helper of the same name in
 * `scan-project-budget.ts`; inlined here so this module is
 * self-contained and the file-size limit pressure on its sibling
 * doesn't recur whenever both helpers want to grow together.
 */
function topLevelDir(relPath: string): string | undefined {
  if (relPath.length === 0) return undefined;
  // Reject absolute paths — `formatted.files[].path` is root-relative
  // POSIX by convention, but a defensive guard keeps the helper honest
  // if a future caller threads through an absolute path.
  if (relPath.startsWith("/")) return undefined;
  const dir = posix.dirname(relPath);
  if (dir === "." || dir === "") return undefined;
  // Take the first segment: `src/foo/bar` → `src`.
  const slash = dir.indexOf("/");
  return slash === -1 ? dir : dir.slice(0, slash);
}
