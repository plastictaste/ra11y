/**
 * Bulk-catalog perf-class detector for `scan_project`.
 *
 * Closes the silent miss described in: a
 * `scan_project` invocation against a vendor-heavy template catalog
 * (canonical repro: 4043 files / 172 templates / 16 MB) ran for 12s vs.
 * the documented 3s budget for a 1000-file project (CLAUDE.md §11
 * performance budget). The response itself is honest — `meta.durationMs`
 * carries the elapsed time and `meta.scannedBuildArtifacts` carries the
 * vendor-file inventory — but neither field reads to the agent as "this
 * scan exceeded the documented budget; here is the lever you have."
 * Without the explicit signal, the agent budgets against the response
 * size rather than the perf class and re-runs the same wide scan when a
 * scoped one would have served better.
 *
 * Doctrine surface ("Numeric-threshold heuristics are suppression"):
 * the thresholds below DO NOT suppress findings, downgrade severities,
 * or filter response content. They gate emission of an additive
 * `bulk_catalog_detected` warning code whose paired
 * `warningsDetails.bulk_catalog_detected` payload echoes the raw
 * `durationMs`, `filesScanned`, and `buildArtifactsCount` numbers the
 * agent reads to decide on its own whether the perf class warrants
 * scope narrowing — same shape as the `vendor_css_dominates_findings`
 * code (additive telemetry, not a suppression lever). The
 * `suggestedExcludes` list is built from the actual top vendor-file
 * basenames detected in the scan; no guessing, no filename heuristics
 * — agents see the concrete files behind the slowdown.
 *
 * Why three trigger paths:
 *
 *   - `slow + vendor` — `durationMs > SLOW_DURATION_MS` AND
 *     `buildArtifactsCount > BULK_BUILD_ARTIFACTS_FLOOR`. The
 *     vendor-heavy regime: the scan is slow and the build-artifact
 *     detector saw a large vendor footprint. The agent's first lever
 *     is a `propose_config` exclude on the named vendor basenames.
 *   - `bulk + vendor` — `filesScanned > BULK_FILES_SCANNED_FLOOR`
 *     AND `buildArtifactsCount > BULK_BUILD_ARTIFACTS_FLOOR`. The
 *     bulk-corpus regime: the file count alone tells the agent the
 *     scan is operating above the documented 1000-file row of the
 *     perf budget; pairing with vendor-heavy avoids firing on a
 *     legitimate large monorepo with hand-authored content.
 *   - `small_demo_catalog` — at least
 *     {@link SMALL_DEMO_CATALOG_MIN_SIBLINGS} sibling subdirs share
 *     an identical per-dir file-shape signature (e.g. each
 *     `<sibling>/` carries the same set of basenames such as
 *     `index.html` + `style.css` + `script.js`). Fires independent
 *     of vendor-heavy because the canonical case is a hand-authored
 *     tutorial / demo catalog where every sub-project is original
 *     source — none of the files vendor-classify, the duration stays
 *     under the slow floor, and the total file count stays under the
 *     bulk floor. The agent's first lever is `additionalPaths` to
 *     scope to one example sub-project rather than re-scanning the
 *     whole catalog.
 *
 * The first two paths require vendor-heavy because the durationMs /
 * filesScanned thresholds alone could fire on legitimate slow scans
 * (cold disk, CPU contention, large hand-authored corpus). The vendor
 * presence is the load-bearing signal that the slowdown is plausibly
 * addressable via exclude globs rather than a structural fact about
 * the codebase. The third path's same-shape sibling-subdir signature
 * IS the load-bearing structural signal — the predicate is provable
 * from the file-path evidence alone, no heuristic guess at "tutorial
 * vs. monorepo" required.
 *
 * Pure over its inputs — no I/O, no filesystem access, no decisions
 * beyond the threshold gate. Lives next to the other scan_project
 * scan-meta detectors (`build-artifacts.ts`, `catalog-detect.ts`,
 * `analysis-coverage.ts`) so the detector to warning wiring stays
 * traceable.
 */

import type { ScannedBuildArtifact } from "./build-artifacts.ts";

/**
 * Slow-duration sentinel for the `slow + vendor` trigger path. Picked
 * at 9s — 3× the documented 3s budget for the 1000-file row in
 * CLAUDE.md §11 — so the warning fires only when the scan is
 * meaningfully over budget rather than on every cache-cold first
 * invocation. Below 3× the budget, retry-on-warm is the agent's
 * normal recovery; above 3× the structural perf class has changed
 * and the agent's lever is scope reduction.
 */
export const SLOW_DURATION_MS = 9000;

/**
 * File-count sentinel for the `bulk + vendor` trigger path. Picked at
 * 1500 — well above the 1000-file row of the perf budget table, well
 * below the 4000-file ceiling row. Below 1500 the budget table itself
 * sets the agent's expectation; above 1500 the scan is operating in
 * the documented "scope down rather than wait" regime per CLAUDE.md
 * §11 ("Above the 1000-file row, prefer scan_diff for precommit and
 * additionalPaths / a narrower cwd for scoped audits").
 */
export const BULK_FILES_SCANNED_FLOOR = 1500;

/**
 * Build-artifact-count sentinel paired with both trigger paths. Picked
 * at 50 — the canonical repro had 172
 * templates with vendor bundles per template, well above this floor;
 * a typical app with one or two stray `dist/foo.min.css` files is well
 * below. The floor is the load-bearing "the slowdown is plausibly
 * vendor-driven" signal: a 12s scan on 4000 files of hand-authored
 * source is structural and shouldn't trip the warning, but the same
 * 12s scan on a vendor-template catalog is addressable via exclude
 * globs.
 */
export const BULK_BUILD_ARTIFACTS_FLOOR = 50;

/**
 * Sibling-subdir count sentinel for the `small_demo_catalog` trigger
 * path. Picked at 30 — well above the small-N noise threshold (a 10-
 * sibling project is plausibly a normal monorepo packages/ layout) and
 * well below the vendor-template-catalog regime the existing slow /
 * bulk paths cover. The canonical case the floor is calibrated against
 * is the ~50-tutorial vanilla-JS course catalog: 50+ sibling subdirs,
 * each carrying the same `index.html` / `style.css` / `script.js` per-
 * dir file shape, none of which are vendor-classified. The duration
 * stays under the slow floor (each sub-project is small) and the
 * file count stays under the bulk floor (50 dirs × 3 files = 150),
 * so neither of the existing trigger paths fires. The same-shape
 * signature IS provable from the file-path evidence alone — no fuzzy
 * "looks like a tutorial" heuristic — and the floor is the load-
 * bearing "this is a parallel-sibling-subprojects regime" signal.
 */
export const SMALL_DEMO_CATALOG_MIN_SIBLINGS = 30;

/**
 * Cap on the number of `exampleSiblings` returned in the
 * `small_demo_catalog` payload. Three is enough to confirm the pattern
 * without padding the warning channel — agents reading
 * `exampleSiblings: ['example-01', 'example-02', 'example-03']` plus
 * the `siblingShapeSignature` have all the evidence they need to
 * recognize the parallel-sibling regime. The full count stays
 * available via `siblingCount`.
 */
export const SMALL_DEMO_CATALOG_EXAMPLE_CAP = 3;

/**
 * Cap on the number of `suggestedExcludes` glob entries returned. Five
 * is enough to cover the canonical vendor-bundle profile (bootstrap +
 * font-awesome + jquery + animate + one custom template asset) without
 * padding the meta block. The full per-path detail still lives on
 * `meta.scannedBuildArtifacts.grouped` / `.ungrouped` for callers that
 * want every basename.
 */
export const SUGGESTED_EXCLUDES_CAP = 5;

/**
 * Trigger-path discriminator on {@link BulkCatalogDetection}. Lets the
 * agent branch on which threshold combination fired without re-deriving
 * it from the raw counts — same pattern as the `pageClipReason` enum on
 * `scan_project` pagination and `dominantContributor` on the
 * `response_token_budget_truncated` payload. `slow_and_vendor_heavy`
 * names the duration-driven path; `bulk_and_vendor_heavy` names the
 * file-count-driven path; `small_demo_catalog` names the same-shape
 * sibling-subdir path (parallel hand-authored sub-projects, neither
 * slow nor bulk).
 *
 * When multiple paths qualify on the same input, the predicate emits
 * the most specific path's label: `slow_and_vendor_heavy` outranks
 * `bulk_and_vendor_heavy` (slowness is the more direct lever); the
 * vendor-heavy paths outrank `small_demo_catalog` because a vendor
 * footprint is the agent's first lever (`propose_config exclude`)
 * regardless of whether the underlying layout is parallel-sibling.
 *
 * Branching guidance for the agent:
 *
 *   - `slow_and_vendor_heavy` / `bulk_and_vendor_heavy`: the first
 *     lever is `propose_config exclude` on the suggested vendor
 *     basenames or a `restrictToPaths` excluding the vendor subtree.
 *   - `small_demo_catalog`: the first lever is `additionalPaths`
 *     scoped to one example sub-project (`exampleSiblings[0]`) so
 *     each sub-project's per-page findings stop being conflated by
 *     the flat scan.
 */
export type BulkCatalogTrigger =
  | "slow_and_vendor_heavy"
  | "bulk_and_vendor_heavy"
  | "small_demo_catalog";

/**
 * Structured detection payload returned by {@link detectBulkCatalog}.
 * Every field is raw, additive context the agent reads to decide
 * whether to act — no thresholds in the payload, no derived
 * "severity" tokens, no English prose beyond the basenames in
 * `suggestedExcludes` (which are exact `**\/<basename>` globs the
 * agent can paste into a `propose_config` `exclude:` entry verbatim).
 *
 * `trigger` names which threshold combination fired so an agent
 * branching on the cause can pick its first lever (`propose_config
 * exclude` for the vendor-heavy paths; `additionalPaths` to one
 * example sub-project for `small_demo_catalog`). `durationMs` /
 * `filesScanned` / `buildArtifactsCount` echo the raw inputs so the
 * agent can compare against its own threshold calibration without
 * reading `meta.durationMs` / `meta.filesScanned` /
 * `meta.scannedBuildArtifacts` separately. `suggestedExcludes` lists
 * the densest vendor-file basenames as `**\/<basename>` glob patterns
 * — the agent reads these and decides whether each glob is in scope;
 * `topVendorFile` names the single densest root-relative path so the
 * agent can inspect the file directly before excluding.
 *
 * `siblingShape` ships only when `trigger === "small_demo_catalog"`
 * (conditional-spread per CLAUDE.md §1 "Ambiguous field shapes are
 * dishonest"). It carries the discovered sibling-subdir count, the
 * shared file-shape signature, and a stable alphabetical prefix of
 * sibling names so the agent can scope-down to one example with
 * `additionalPaths: ["<exampleSiblings[0]>"]`.
 */
export interface BulkCatalogDetection {
  readonly trigger: BulkCatalogTrigger;
  readonly durationMs: number;
  readonly filesScanned: number;
  readonly buildArtifactsCount: number;
  readonly suggestedExcludes: readonly string[];
  readonly topVendorFile?: string;
  readonly siblingShape?: SmallDemoCatalogShape;
}

/**
 * Same-shape sibling-subdir evidence carried on
 * {@link BulkCatalogDetection.siblingShape} when the
 * `small_demo_catalog` trigger fires. `siblingCount` names how many
 * sibling subdirs share the same per-dir basename signature;
 * `signature` is the sorted-distinct list of basenames that defines
 * the shared shape (e.g. `["index.html", "script.js", "style.css"]`);
 * `exampleSiblings` is a stable alphabetical prefix of the qualifying
 * sibling subdir names (capped at
 * {@link SMALL_DEMO_CATALOG_EXAMPLE_CAP}) so the agent has concrete
 * `additionalPaths` candidates without iterating the full list.
 */
export interface SmallDemoCatalogShape {
  readonly siblingCount: number;
  readonly signature: readonly string[];
  readonly exampleSiblings: readonly string[];
}

/**
 * Inputs to {@link detectBulkCatalog}. Every field is supplied by the
 * `scan_project` handler at the same point it builds the warning
 * pipeline — the detector stays pure over the values it receives so
 * unit tests can pin the threshold logic without standing up a scan
 * harness.
 *
 * `parsedFilePaths` carries the root-relative POSIX paths of every
 * parsed file in the scan; the detector walks these to identify the
 * `small_demo_catalog` same-shape sibling-subdir signature without
 * touching the filesystem. Pass an empty list when the caller does
 * not have parsed-file paths in hand — the small-demo-catalog path
 * then drops conservatively.
 */
export interface BulkCatalogInputs {
  readonly durationMs: number;
  readonly filesScanned: number;
  readonly buildArtifacts: readonly ScannedBuildArtifact[];
  readonly parsedFilePaths?: readonly string[];
  /**
   * Absolute POSIX path of the scan root, used to relativize
   * `parsedFilePaths` entries before grouping by sibling subdir.
   * Pass `undefined` when `parsedFilePaths` is absent or already
   * relative; the detector accepts either form (any path that
   * starts with `root` is stripped of the prefix; any other path
   * is bucketed by its existing first-segment).
   */
  readonly root?: string;
}

/**
 * Returns a {@link BulkCatalogDetection} when the input clears one of
 * the three trigger paths described in the file header; returns
 * `undefined` otherwise so the caller can conditional-spread the
 * warning fragment per CLAUDE.md §1 "Ambiguous field shapes are
 * dishonest." Pure over its inputs — no I/O.
 *
 * Path precedence: vendor-heavy paths win over `small_demo_catalog`
 * because the agent's first lever differs. When a corpus is both
 * vendor-heavy and small-demo-shaped (rare — would require many
 * sibling tutorials each with vendor bundles), the vendor-heavy
 * label fires first so the agent reaches for `propose_config exclude`
 * before scoping with `additionalPaths`.
 */
export function detectBulkCatalog(inputs: BulkCatalogInputs): BulkCatalogDetection | undefined {
  const { durationMs, filesScanned, buildArtifacts } = inputs;
  const buildArtifactsCount = buildArtifacts.length;
  const vendorEligible = buildArtifactsCount > BULK_BUILD_ARTIFACTS_FLOOR;
  const slowAndVendor = vendorEligible && durationMs > SLOW_DURATION_MS;
  const bulkAndVendor = vendorEligible && filesScanned > BULK_FILES_SCANNED_FLOOR;
  if (slowAndVendor || bulkAndVendor) {
    // Slow-and-vendor wins on the trigger label when both fire — the
    // duration is the more direct signal the agent acts on (scope down
    // to recover the budget); file count is the structural backdrop.
    const trigger: BulkCatalogTrigger = slowAndVendor
      ? "slow_and_vendor_heavy"
      : "bulk_and_vendor_heavy";
    const suggestedExcludes = topVendorBasenameGlobs(buildArtifacts);
    const topVendorFile = buildArtifacts[0]?.path;
    return {
      trigger,
      durationMs,
      filesScanned,
      buildArtifactsCount,
      suggestedExcludes,
      ...(topVendorFile === undefined ? {} : { topVendorFile }),
    };
  }
  // No vendor-heavy path qualifies — try the structural same-shape
  // sibling-subdir signature. This is the carve-out the multi-corpus
  // backlog item names: a small-N catalog of parallel tutorials /
  // demos whose duration stays under SLOW_DURATION_MS, file count
  // stays under BULK_FILES_SCANNED_FLOOR, and build-artifact count
  // stays under BULK_BUILD_ARTIFACTS_FLOOR (every sub-project is
  // hand-authored, so none vendor-classify).
  const siblingShape = detectSmallDemoCatalogShape(inputs.parsedFilePaths, inputs.root);
  if (siblingShape === undefined) return undefined;
  return {
    trigger: "small_demo_catalog",
    durationMs,
    filesScanned,
    buildArtifactsCount,
    // Empty when no vendor footprint exists — agents reading the
    // payload see the empty list as honest "no vendor exclude lever
    // available; use additionalPaths instead." The siblingShape
    // payload below carries the alternative lever.
    suggestedExcludes: [],
    siblingShape,
  };
}

/**
 * Detects the same-shape sibling-subdir signature underpinning the
 * `small_demo_catalog` trigger. Algorithm:
 *
 *   1. Relativize each parsed file path against `root` (strip the
 *      prefix); paths outside `root` (or absent) keep their original
 *      form.
 *   2. Bucket relative paths by their first segment (the candidate
 *      sibling subdir name); ignore paths with no segment separator
 *      (top-level files don't contribute) and dotfile siblings.
 *   3. For each candidate sibling subdir, compute the sorted-distinct
 *      list of immediate-child basenames (the file-shape signature).
 *      A subdir whose first-level descendants are e.g.
 *      `index.html`, `style.css`, `script.js` produces signature
 *      `["index.html", "script.js", "style.css"]`.
 *   4. Group sibling subdirs by signature; the largest group wins.
 *      When at least {@link SMALL_DEMO_CATALOG_MIN_SIBLINGS} subdirs
 *      share the same signature, return the
 *      {@link SmallDemoCatalogShape} payload. Otherwise return
 *      `undefined`.
 *
 * Pure data transformation — no filesystem reads. Returns `undefined`
 * when `parsedFilePaths` is missing/empty or no sibling group clears
 * the floor.
 *
 * Folded into three helpers so the cognitive complexity stays under
 * the lint cap: {@link bucketByImmediateSibling} owns the per-path
 * bucketing, {@link relativeImmediateChild} owns the per-path
 * predicate, and {@link pickLargestSameShapeSiblingGroup} owns the
 * signature-grouping pass.
 */
function detectSmallDemoCatalogShape(
  parsedFilePaths: readonly string[] | undefined,
  root: string | undefined,
): SmallDemoCatalogShape | undefined {
  if (parsedFilePaths === undefined || parsedFilePaths.length === 0) return undefined;
  const rootPosix = root === undefined ? undefined : normalizeToPosix(root);
  const siblingFiles = bucketByImmediateSibling(parsedFilePaths, rootPosix);
  if (siblingFiles.size < SMALL_DEMO_CATALOG_MIN_SIBLINGS) return undefined;
  const winner = pickLargestSameShapeSiblingGroup(siblingFiles);
  if (winner === undefined || winner.siblings.length < SMALL_DEMO_CATALOG_MIN_SIBLINGS) {
    return undefined;
  }
  return {
    siblingCount: winner.siblings.length,
    signature: winner.signature,
    exampleSiblings: winner.siblings.slice(0, SMALL_DEMO_CATALOG_EXAMPLE_CAP),
  };
}

/**
 * Bucket each parsed file path into a sibling-subdir to immediate-
 * child-basenames map. Skips top-level files (no sibling subdir under
 * root), dotfile siblings (`.github/` etc.), and files that aren't
 * immediate children of their sibling subdir (deeply-nested sub-
 * project layouts like `app-N/pages/index.tsx` don't contribute, by
 * design — the same-shape signature is per-dir file shape, not whole-
 * subtree manifest).
 */
function bucketByImmediateSibling(
  parsedFilePaths: readonly string[],
  rootPosix: string | undefined,
): Map<string, Set<string>> {
  const siblingFiles = new Map<string, Set<string>>();
  for (const filePath of parsedFilePaths) {
    const entry = relativeImmediateChild(filePath, rootPosix);
    if (entry === undefined) continue;
    const set = siblingFiles.get(entry.sibling);
    if (set === undefined) siblingFiles.set(entry.sibling, new Set([entry.basename]));
    else set.add(entry.basename);
  }
  return siblingFiles;
}

/**
 * Resolve a single parsed file path to its `(sibling, basename)`
 * coordinate, or `undefined` if the path doesn't qualify as an
 * immediate child of a sibling subdir under `rootPosix`. Folded out
 * of {@link bucketByImmediateSibling} so the per-path predicate
 * stays one cognitive-unit per branch.
 */
function relativeImmediateChild(
  filePath: string,
  rootPosix: string | undefined,
): { sibling: string; basename: string } | undefined {
  const rel = stripRootPrefix(normalizeToPosix(filePath), rootPosix);
  if (rel.length === 0) return undefined;
  const slashIdx = rel.indexOf("/");
  if (slashIdx <= 0) return undefined; // top-level file
  const sibling = rel.slice(0, slashIdx);
  if (sibling.length === 0 || sibling.startsWith(".")) return undefined;
  const rest = rel.slice(slashIdx + 1);
  if (rest.length === 0 || rest.includes("/")) return undefined;
  return { sibling, basename: rest };
}

/**
 * Group sibling subdirs by their sorted-distinct immediate-child
 * basename signature; return the largest group's
 * `{ siblings, signature }` pair (alphabetically sorted siblings),
 * or `undefined` if no group exists. The caller checks the size
 * floor.
 *
 * The signature stored alongside each group's key is the original
 * sorted-distinct basename array (not a re-split string), so the
 * shape stays string-array-pure regardless of what characters appear
 * in the basenames.
 */
function pickLargestSameShapeSiblingGroup(
  siblingFiles: ReadonlyMap<string, ReadonlySet<string>>,
): { siblings: string[]; signature: readonly string[] } | undefined {
  const signatureGroups = new Map<string, { signature: readonly string[]; siblings: string[] }>();
  for (const [sibling, basenames] of siblingFiles) {
    if (basenames.size === 0) continue;
    const sortedBasenames = [...basenames].sort();
    // Newline as the join separator: POSIX path components cannot
    // contain a literal newline, so the key never collides with a
    // basename character. Group key is internal-only; the canonical
    // signature is the sorted array we store alongside it.
    const signatureKey = sortedBasenames.join("\n");
    const existing = signatureGroups.get(signatureKey);
    if (existing === undefined) {
      signatureGroups.set(signatureKey, { signature: sortedBasenames, siblings: [sibling] });
    } else {
      existing.siblings.push(sibling);
    }
  }
  let best: { siblings: string[]; signature: readonly string[] } | undefined;
  for (const [, group] of signatureGroups) {
    if (best === undefined || group.siblings.length > best.siblings.length) {
      best = group;
    }
  }
  if (best === undefined) return undefined;
  best.siblings.sort((a, b) => a.localeCompare(b));
  return best;
}

/**
 * Normalize a path to POSIX separators so the sibling-subdir grouping
 * stays portable across platforms. Trims a trailing slash so the
 * downstream prefix-strip math doesn't double-count separators.
 */
function normalizeToPosix(p: string): string {
  const posix = p.replace(/\\/g, "/");
  return posix.endsWith("/") ? posix.slice(0, -1) : posix;
}

/**
 * Strip a trailing-slash-tolerant `rootPosix` prefix from `pathPosix`.
 * When `rootPosix` is undefined, or the path doesn't start with the
 * prefix, returns the input unchanged. The leading `/` between root
 * and the first sibling-subdir segment is also stripped so the result
 * is a clean root-relative POSIX path.
 */
function stripRootPrefix(pathPosix: string, rootPosix: string | undefined): string {
  if (rootPosix === undefined) return pathPosix;
  if (!pathPosix.startsWith(rootPosix)) return pathPosix;
  const after = pathPosix.slice(rootPosix.length);
  return after.startsWith("/") ? after.slice(1) : after;
}

/**
 * Builds the `suggestedExcludes` list from the actual top vendor-file
 * basenames in the build-artifact entries. Returns up to
 * {@link SUGGESTED_EXCLUDES_CAP} `**\/<basename>` glob patterns so
 * the agent reads concrete file shapes the scan actually saw — no
 * guessing, no canned `bootstrap*.css` / `animate*.css` literals
 * fired on every catalog.
 *
 * Selection: bucket entries by basename, sort by count descending
 * (alphabetical tie-break for determinism across runs), take the
 * top N basenames, emit each as `**\/<basename>` so the glob covers
 * every directory the basename appears in across the corpus. The
 * `**\/` prefix matches the same root-relative POSIX shape the
 * `meta.scannedBuildArtifacts.grouped[].suggestedGlob` field already
 * emits — agents reading both surfaces see consistent glob
 * vocabulary.
 *
 * Returns `[]` when the input is empty so the caller's
 * conditional-spread fires the empty case (the predicate guarantees
 * non-empty input when the warning code fires, but the helper stays
 * defensive).
 */
function topVendorBasenameGlobs(
  buildArtifacts: readonly ScannedBuildArtifact[],
): readonly string[] {
  if (buildArtifacts.length === 0) return [];
  const counts = new Map<string, number>();
  for (const entry of buildArtifacts) {
    const basename = pathBasename(entry.path);
    if (basename.length === 0) continue;
    counts.set(basename, (counts.get(basename) ?? 0) + 1);
  }
  const entries = [...counts.entries()];
  // Descending by count; alphabetical tie-break for determinism.
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.slice(0, SUGGESTED_EXCLUDES_CAP).map(([basename]) => `**/${basename}`);
}

/**
 * Extracts the basename from a POSIX path. Inline rather than
 * importing `node:path` so the detector stays a pure data
 * transformation and the test surface doesn't need to mock the path
 * module — every entry on `ScannedBuildArtifact.path` is already
 * root-relative POSIX (per the `groupBuildArtifactsByBasename`
 * relativization pass in `build-artifacts.ts`), so a simple
 * last-slash split is sufficient.
 */
function pathBasename(path: string): string {
  const slashIdx = path.lastIndexOf("/");
  return slashIdx === -1 ? path : path.slice(slashIdx + 1);
}
