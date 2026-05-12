/**
 * Build-artifact / minified-file summary builders for the warnings
 * channel. Both `scanned_build_artifacts_present` and the paired
 * `scanned_minified_file` codes ship a `{ count, topPath?, top? }`
 * envelope at default verbosity — `count` carries the dominant-noise
 * scope, `topPath` names the first triage pivot, `top` is a head-slice
 * the agent reads to recognize the dismissal pattern in one pass
 * without descending into `meta.scannedBuildArtifacts`. The two paired
 * codes share the same `SCANNED_BUILD_ARTIFACTS_TOP_CAP` head-slice
 * limit so their payloads stay structurally aligned regardless of
 * input size. Full identity for per-file decisions lives on
 * `meta.scannedBuildArtifacts.classified[]` filtered by classification.
 *
 * Lives in its own sibling file so the parent scan-time-warnings
 * aggregator and the scan-project handler can both reuse the
 * minified-summary builder without re-exporting through the
 * aggregator's per-file budget.
 */
import type { WarningInputs } from "./warnings.ts";
import { SCANNED_BUILD_ARTIFACTS_TOP_CAP } from "./warnings.ts";

/**
 * Builds the `scannedMinifiedFilesSummary` summary surfaced on
 * `warningsDetails.scanned_minified_file` from the caller-supplied
 * minified-classified path list. Returns `undefined` when the list is
 * empty so the warnings module's summarizer falls through to the
 * schema-discipline sentinel. The sort runs here once so callers
 * don't need to pre-sort (the build-artifact pipeline emits in
 * discovery order, which is not guaranteed stable across filesystems).
 */
export function buildScannedMinifiedFilesSummary(
  files: readonly string[],
): WarningInputs["scannedMinifiedFilesSummary"] {
  if (files.length === 0) return undefined;
  const sorted = [...files].sort();
  const top = sorted.slice(0, SCANNED_BUILD_ARTIFACTS_TOP_CAP);
  return {
    count: sorted.length,
    ...(sorted[0] === undefined ? {} : { topPath: sorted[0] }),
    ...(top.length === 0 ? {} : { top }),
  };
}
