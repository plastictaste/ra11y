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
 * Why two trigger paths:
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
 *
 * Both paths require vendor-heavy because the durationMs / filesScanned
 * thresholds alone could fire on legitimate slow scans (cold disk, CPU
 * contention, large hand-authored corpus). The vendor presence is the
 * load-bearing signal that the slowdown is plausibly addressable via
 * exclude globs rather than a structural fact about the codebase.
 *
 * Pure over its inputs — no I/O, no filesystem access, no decisions
 * beyond the threshold gate. Lives next to the other scan_project
 * scan-meta detectors (`build-artifacts.ts`, `catalog-detect.ts`,
 * `analysis-coverage.ts`) so the detector ↔ warning wiring stays
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
 * file-count-driven path. Both can fire (a scan that's both slow and
 * bulk); the predicate emits the more specific `slow_and_vendor_heavy`
 * label first because slowness is the signal the agent acts on more
 * directly (scope down to recover speed) than file count alone.
 */
export type BulkCatalogTrigger = "slow_and_vendor_heavy" | "bulk_and_vendor_heavy";

/**
 * Structured detection payload returned by {@link detectBulkCatalog}.
 * Every field is raw, additive context the agent reads to decide
 * whether to act — no thresholds in the payload, no derived
 * "severity" tokens, no English prose beyond the basenames in
 * `suggestedExcludes` (which are exact `**\/<basename>` globs the
 * agent can paste into a `propose_config` `exclude:` entry verbatim).
 *
 * `trigger` names which threshold combination fired so an agent
 * branching on the cause can pick its first lever (scope-down for
 * `slow_and_vendor_heavy`; per-template recursion for
 * `bulk_and_vendor_heavy`). `durationMs` / `filesScanned` /
 * `buildArtifactsCount` echo the raw inputs so the agent can compare
 * against its own threshold calibration without reading
 * `meta.durationMs` / `meta.filesScanned` / `meta.scannedBuildArtifacts`
 * separately. `suggestedExcludes` lists the densest vendor-file
 * basenames as `**\/<basename>` glob patterns — the agent reads
 * these and decides whether each glob is in scope; `topVendorFile`
 * names the single densest root-relative path so the agent can
 * inspect the file directly before excluding.
 */
export interface BulkCatalogDetection {
  readonly trigger: BulkCatalogTrigger;
  readonly durationMs: number;
  readonly filesScanned: number;
  readonly buildArtifactsCount: number;
  readonly suggestedExcludes: readonly string[];
  readonly topVendorFile?: string;
}

/**
 * Inputs to {@link detectBulkCatalog}. Every field is supplied by the
 * `scan_project` handler at the same point it builds the warning
 * pipeline — the detector stays pure over the values it receives so
 * unit tests can pin the threshold logic without standing up a scan
 * harness.
 */
export interface BulkCatalogInputs {
  readonly durationMs: number;
  readonly filesScanned: number;
  readonly buildArtifacts: readonly ScannedBuildArtifact[];
}

/**
 * Returns a {@link BulkCatalogDetection} when the input clears one of
 * the two trigger paths described in the file header; returns
 * `undefined` otherwise so the caller can conditional-spread the
 * warning fragment per CLAUDE.md §1 "Ambiguous field shapes are
 * dishonest." Pure over its inputs — no I/O.
 */
export function detectBulkCatalog(inputs: BulkCatalogInputs): BulkCatalogDetection | undefined {
  const { durationMs, filesScanned, buildArtifacts } = inputs;
  const buildArtifactsCount = buildArtifacts.length;
  if (buildArtifactsCount <= BULK_BUILD_ARTIFACTS_FLOOR) return undefined;
  const slowAndVendor = durationMs > SLOW_DURATION_MS;
  const bulkAndVendor = filesScanned > BULK_FILES_SCANNED_FLOOR;
  if (!(slowAndVendor || bulkAndVendor)) return undefined;
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
