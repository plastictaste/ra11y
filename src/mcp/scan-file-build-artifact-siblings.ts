/**
 * Directory-sibling probe for scan_file's build-artifact lane parity.
 *
 * Closes the cross-surface drift documented under
 * `docs/kb/architecture/ai-first-consumer.md` "Per-tool lane and
 * warning-set classification must agree": `scan_project` walks the
 * full corpus and the `collectBuildArtifacts` classifier sees every
 * sibling, so a non-min vendor source paired with its `.min.<ext>`
 * twin (canonical AdminLTE / jQuery shape) classifies as
 * `definite-vendor-distribution` via the sibling-pair predicate.
 * `scan_file` historically passed the single parsed file alone — the
 * sibling-pair evidence was structurally invisible, the file routed
 * into the `source` lane, and the agent calling `scan_file` first on
 * a vendor stylesheet got a different mental model of the same input
 * than `scan_project` would have given.
 *
 * The probe reads the target file's parent directory exactly once,
 * filters to filenames whose shape can corroborate the sibling-pair
 * predicates (`findSiblingMinFile` / `findSiblingSourcemap` in
 * `build-artifacts-vendor-distribution.ts`), and returns their full
 * paths. The caller threads the list as `auxiliaryPaths` through
 * `collectBuildArtifacts`, augmenting the `pathsInSet` membership
 * check without introducing synthetic classification rows.
 *
 * Bounded work: at most one `readdirSync` on the target's parent. The
 * filter narrows to `.min.<ext>` twins of the target's basename and
 * `<basename>.map` sourcemap pointers — every other directory entry
 * is skipped, so the helper is O(directory size) but constant-cost in
 * predicate evaluation per entry.
 *
 * Pure with respect to its return value (no side effects beyond the
 * read); silent on every error path. The probe is best-effort
 * augmentation: if the directory cannot be read (permissions, the
 * target points at a stream / device, etc.), the probe returns an
 * empty list and the classifier falls back to the source-text
 * predicates as before. Failure here is never a hard error — the
 * scan_file call still produces an honest response, the lane label
 * just reverts to the pre-fix shape (and the source-text predicates
 * — sourcemap-pointer / banner-with-version — still classify on
 * source bytes alone).
 */

import { readdirSync } from "node:fs";
import { posixDirname } from "../utils/path.ts";

/**
 * Reads the parent directory of `filePath` once and returns the
 * subset of sibling paths whose filename shape can drive a
 * sibling-pair classification on the target.
 *
 * Two sibling shapes are relevant per the predicates in
 * `build-artifacts-vendor-distribution.ts`:
 *
 *   - `<stem>.min.<ext>` — the minified twin of a readable source.
 *     `findSiblingMinFile` reads `pathsInSet` for this exact shape;
 *     when present, the readable source classifies as
 *     `definite-vendor-distribution`.
 *
 *   - `<stem>.<ext>.map` — the sourcemap paired to a readable source.
 *     `findSiblingSourcemap` reads `pathsInSet` for this exact shape;
 *     when present, the source classifies as
 *     `definite-sourcemap-paired`.
 *
 * Both predicates require the candidate sibling to live in the same
 * directory as the target — the helper only reads the immediate
 * parent and never walks subdirectories. Returns `[]` on any read
 * failure (the probe is best-effort augmentation).
 *
 * @param filePath Absolute path of the scan_file target.
 * @returns Sibling paths in POSIX form, empty list on any read failure.
 */
export function probeDirectoryForArtifactSiblings(filePath: string): readonly string[] {
  const dir = posixDirname(filePath);
  if (dir === null || dir.length === 0) return [];
  const normalizedTarget = filePath.replace(/\\/g, "/");
  const targetBasename = basenameOf(normalizedTarget);
  if (targetBasename.length === 0) return [];
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry === targetBasename) continue;
    if (!isInterestingSibling(entry, targetBasename)) continue;
    out.push(`${dir}/${entry}`);
  }
  return out;
}

/**
 * `true` when `entry` is a sibling whose filename shape can corroborate
 * a sibling-pair classification of `targetBasename`. Two cases:
 *
 *   1. `targetBasename` is `<stem>.<ext>` and `entry` is its minified
 *      twin `<stem>.min.<ext>` (e.g. `adminlte.css` paired with
 *      `adminlte.min.css`). Drives `findSiblingMinFile`.
 *
 *   2. `targetBasename` is `<stem>.<ext>` and `entry` is its sourcemap
 *      `<stem>.<ext>.map` (e.g. `app.js` paired with `app.js.map`).
 *      Drives `findSiblingSourcemap`.
 *
 * Files that don't match either pair are skipped — the probe is
 * scoped precisely to evidence the classifier consults, so a directory
 * with hundreds of unrelated entries pays only the linear scan, not
 * the synthetic-classification cost. Returns `false` for the target
 * itself (caller filters that case out separately).
 */
function isInterestingSibling(entry: string, targetBasename: string): boolean {
  const lastDot = targetBasename.lastIndexOf(".");
  if (lastDot === -1) return false;
  const stem = targetBasename.slice(0, lastDot);
  const ext = targetBasename.slice(lastDot);
  // Minified twin: `<stem>.min<ext>` (the dot before `min` is the
  // boundary `findSiblingMinFile` inserts; the original extension
  // follows verbatim).
  if (entry === `${stem}.min${ext}`) return true;
  // Sourcemap pair: `<basename>.map` literally — `findSiblingSourcemap`
  // appends `.map` to the full target path.
  if (entry === `${targetBasename}.map`) return true;
  return false;
}

function basenameOf(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash === -1 ? filePath : filePath.slice(slash + 1);
}
