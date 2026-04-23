/**
 * Vendor-aware enrichment for `perRuleCoverage[].concentration`.
 *
 * The engine-level `buildPerRuleCoverage` helper in
 * `src/engine/per-rule-coverage.ts` picks the densest file for each
 * rule and stamps the base {@link PerRuleCoverage.concentration} hint
 * when a rule's findings cluster there (> 10 total findings AND the
 * densest file holds > 50% of them — V1-NOISE-RULE-PER-FILE-ROLLUP).
 * The engine can't know whether the densest file is authored code or a
 * vendored build artifact — build-artifact classification lives in
 * `src/mcp/build-artifacts.ts`, and the engine invariant forbids
 * `src/engine/` importing from `src/mcp/`.
 *
 * This helper runs in the MCP assembly layer — where the vendor file
 * set is already resolved via `collectBuildArtifacts` — and re-stamps
 * concentration rows with `kind: "vendor"` when the densest file is a
 * vendor artifact AND the finding count clears a stricter vendor-only
 * floor ({@link VENDOR_CONCENTRATION_MIN_TOTAL}). Below the floor, the
 * base concentration still surfaces unchanged — vendor awareness is
 * additive, not a new gate, per CLAUDE.md §1 "Surface, don't suppress"
 * (Q6-MOTION-PAUSE-STOP-PER-FILE-AGGREGATION).
 *
 * Canonical acute case: `motion/pause-stop-hide` fired 8940× against
 * `vendor/bootstrap/bootstrap.css` on a real scan. The base
 * concentration already named the file; this enrichment adds the
 * `kind: "vendor"` tag so an agent reading the telemetry sees "most of
 * this rule's fire is one vendor file" in one field read instead of
 * having to cross-reference `scannedBuildArtifacts` themselves.
 */

import type { PerRuleCoverage } from "../types/violation.ts";

/**
 * Minimum finding count on a single vendor file before the
 * `kind: "vendor"` annotation stamps. Deliberately stricter than the
 * base concentration floor (> 10 for V1-NOISE-RULE-PER-FILE-ROLLUP)
 * because vendor density only becomes agent-actionable triage signal
 * at scale — a rule firing 15× across vendor `bootstrap.css` could
 * still reflect real authored-css-style patterns that the vendor
 * happens to host, but 100+ findings on one vendor bundle reads
 * unambiguously as "vendor noise dominates this rule's fire." The
 * agent uses the stricter annotation to decide whether to route its
 * first action at authored code elsewhere (see
 * Q6-NEXTSTEP-AVOIDS-VENDOR-CSS for the paired next-step re-routing).
 *
 * Inclusive `>=` semantics — the annotation stamps at exactly 100 so a
 * vendor file with precisely the floor count still reads as "vendor
 * noise dominates." This aligns with the CLASS_PATTERN_MIN_COUNT
 * direction in `per-rule-coverage.ts` (cluster-size questions default
 * `>=`); the singular RULE_CONCENTRATION_MIN_TOTAL uses strict `>`
 * because it's asking a different question ("does one file dominate
 * the whole rule?") where a strict threshold reads cleaner.
 */
export const VENDOR_CONCENTRATION_MIN_TOTAL = 100;

/**
 * Returns a new `perRuleCoverage` array with `kind: "vendor"` stamped
 * on any `concentration` whose densest file is in the vendor path set
 * AND whose count clears {@link VENDOR_CONCENTRATION_MIN_TOTAL}. Pure
 * over its inputs — callers get a fresh array so the input can stay
 * readonly across the rest of the assembly pipeline.
 *
 * Zero information loss — every finding continues to ship in
 * `files[].findings`; this is additive telemetry, not a filter. Rows
 * without a base `concentration` pass through unchanged; rows whose
 * concentration targets an authored file also pass through unchanged
 * (authored is the unannotated default — the absence of `kind`
 * already conveys "not vendor," and adding a redundant
 * `kind: "authored"` would bloat every row's concentration hint for
 * no signal gain).
 *
 * No-op when `vendorFilePaths` is empty — the common case on scans
 * that produce zero build artifacts, and callers shouldn't pay for a
 * re-traversal in that case.
 */
export function enrichPerRuleCoverageWithVendorConcentration(
  perRuleCoverage: readonly PerRuleCoverage[],
  vendorFilePaths: ReadonlySet<string>,
): readonly PerRuleCoverage[] {
  if (vendorFilePaths.size === 0) return perRuleCoverage;
  let anyRewritten = false;
  const out: PerRuleCoverage[] = [];
  for (const row of perRuleCoverage) {
    const enriched = stampVendorKindIfApplicable(row, vendorFilePaths);
    if (enriched !== row) anyRewritten = true;
    out.push(enriched);
  }
  // When no row was rewritten, return the input reference so tests
  // and downstream consumers can rely on identity-equality to detect
  // "nothing changed" without a deep walk. Matches the "honest shape"
  // default — don't materialize churn the caller can't observe.
  return anyRewritten ? out : perRuleCoverage;
}

/**
 * Returns the row with `concentration.kind: "vendor"` stamped when
 * both the densest-file-in-vendor-set and count-over-floor gates
 * clear; otherwise returns the input row verbatim (identity-stable).
 * Called once per row by {@link enrichPerRuleCoverageWithVendorConcentration}.
 */
function stampVendorKindIfApplicable(
  row: PerRuleCoverage,
  vendorFilePaths: ReadonlySet<string>,
): PerRuleCoverage {
  const concentration = row.concentration;
  if (concentration === undefined) return row;
  if (concentration.count < VENDOR_CONCENTRATION_MIN_TOTAL) return row;
  if (!vendorFilePaths.has(concentration.file)) return row;
  // Row already annotated — defensive no-op so repeated enrichment
  // passes (e.g. when the helper is wired at multiple seams during a
  // migration) stay idempotent.
  if (concentration.kind === "vendor") return row;
  return {
    ...row,
    concentration: {
      file: concentration.file,
      count: concentration.count,
      kind: "vendor",
    },
  };
}
