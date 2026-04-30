/**
 * Corpus-aggregation per-rule-coverage adjuster — sibling of
 * {@link import("./parse-error-adjustment.ts").applyParseErrorAdjustment}
 * on the orthogonal corpus-aggregate axis.
 *
 * Doctrine source: `docs/kb/architecture/ai-first-consumer.md`
 *   - "Parser-failure invalidates per-file confidence"
 *   - "Per-finding confidence must reflect per-rule coverage limitations"
 *
 * Why this exists separately from {@link applyParseErrorAdjustment}: the
 * per-file adjuster (Q9 doctrine) intentionally lets a rule's aggregate
 * stay `"high"` as long as at least
 * {@link import("./parse-error-adjustment.ts").MIN_CLEAN_FILES_FOR_AGGREGATE_HIGH}
 * cleanly-evaluated files survive — a single parse-error file in a
 * corpus must NOT blanket-degrade every rule's aggregate. That preserves
 * rule-level honesty when one file out of hundreds bails.
 *
 * The bulk-corpus failure mode the per-file adjuster *cannot* see: when
 * 12% of a 4000-file corpus crashes the parser (templates with
 * `{{ }}` directives the tsx parser bails on, .erb / .liquid files,
 * mixed-syntax shards), every rule with ≥1 cleanly-parsed file still
 * reads `coverageConfidence: "high"` even though hundreds of its
 * eligible files were invisible. The per-file `byFile[]` channel lists
 * the bounded files faithfully, but the aggregate scalar is the field
 * an agent budgets against — and the silent-miss failure mode the
 * doctrine "Parser-failure invalidates per-file confidence" names at
 * the per-file layer recurs at the corpus layer when the invisible-
 * file population is large enough that the rule's clean-evidence
 * coverage is materially incomplete.
 *
 * Threshold cascade (deterministic, no heuristics — the ratio is
 * provable from the recorded `byFile` count divided by `filesEligible`):
 *
 *   - `≥10% AND <25%` → drop aggregate to `"medium"` with
 *     `coverageConfidenceReason: "corpus-parse-error-rate-above-threshold"`.
 *     The rule still has clean evidence but its corpus-level coverage
 *     is honestly bounded.
 *   - `≥25%` → drop aggregate to `"low"` with the same reason. The
 *     bulk of the rule's eligible files were invisible; an agent
 *     reading "high" here would be materially misled.
 *
 * Operates only on rows currently at `"high"` — rows already degraded
 * by an earlier adjuster (parse-error, scss-unresolved-variables,
 * fragment-input, scss-partial-input) keep their more-specific reason.
 * The corpus axis fills the gap between "no clean evidence at all"
 * (parse-error adjuster handles that) and "clean evidence dominates
 * the corpus" (per-file `byFile` is enough), not a replacement for
 * either.
 *
 * Composition with the per-file adjuster: this adjuster runs AFTER
 * {@link applyParseErrorAdjustment} so it can read the populated
 * `byFile` array as the corpus-degradation count. Rows whose
 * `byFile` is undefined or empty (no parse-error / partial-parse
 * matches in the rule's gate) pass through unchanged.
 */

import type { PerRuleCoverage } from "../types/violation.ts";

/**
 * Minimum `filesEligible` count required before the corpus-rate
 * threshold is meaningful. Below this floor the ratio is dominated by
 * per-file noise (1/3 = 33% on a 3-file corpus would otherwise drop
 * a rule to `"low"` on what is honestly a bounded sample). The per-
 * file `byFile` channel still carries the per-file degradation; only
 * the aggregate scalar is gated on this floor.
 *
 * Set to 10 to match the 10% medium threshold's denominator
 * arithmetic — at `filesEligible: 10` a single parse-error file is
 * exactly 10% and trips the medium downgrade; below 10 the per-file
 * adjuster's signal is the load-bearing surface.
 */
const MIN_ELIGIBLE_FOR_CORPUS_RATE_THRESHOLD = 10;

/**
 * Threshold above which the corpus parse-error rate drops the
 * aggregate to `"medium"`. Per the AI-first doctrine "Numeric-
 * threshold heuristics are suppression," the ratio is recorded
 * additively in the row's `reason` text so the agent can read the
 * exact percentage and decide whether to scope down or re-run on a
 * cleaner subset; the threshold itself is the deterministic gate
 * that flips the aggregate scalar.
 */
const CORPUS_PARSE_ERROR_RATE_MEDIUM_THRESHOLD = 0.1;

/**
 * Threshold above which the corpus parse-error rate drops the
 * aggregate to `"low"`. Once 25% or more of a rule's eligible files
 * crashed the parser, the rule's clean-evidence coverage is
 * materially incomplete and an agent reading `"high"` would
 * over-trust the tally.
 */
const CORPUS_PARSE_ERROR_RATE_LOW_THRESHOLD = 0.25;

/**
 * Adjusts {@link PerRuleCoverage} rows so the aggregate
 * `coverageConfidence` reflects the proportion of the rule's eligible
 * files that failed to parse cleanly (corpus-aggregation axis,
 * orthogonal to the per-file `byFile` axis the parse-error adjuster
 * populates).
 *
 * Sequencing: must run AFTER
 * {@link import("./parse-error-adjustment.ts").applyParseErrorAdjustment}
 * — this adjuster reads the `byFile` array the parse-error pass
 * populates as its corpus-degradation evidence.
 *
 * Composition rules:
 *
 *   - Rows currently at `"low"` pass through unchanged (already at
 *     the most-degraded label; the corpus axis cannot worsen it).
 *   - Rows currently at `"medium"` (downgraded by an earlier adjuster
 *     for substrate-specific reasons like `scss-unresolved-variables`
 *     or `fragment-input-no-document-envelope`) pass through unchanged
 *     — the more-specific reason wins. The doctrine "keep the most
 *     degraded label across axes" applies on the strength axis, not
 *     the reason axis; clobbering a substrate-specific reason with
 *     the corpus rate would lose triage signal the agent needs.
 *   - Rows with `skipReason: "gated_by_level"` pass through (rule
 *     never ran; aggregating its eligible files is meaningless).
 *   - Rows with `filesEligible < MIN_ELIGIBLE_FOR_CORPUS_RATE_THRESHOLD`
 *     pass through (denominator too small for the ratio to be
 *     meaningful; per-file `byFile` carries the signal).
 *   - Rows with empty / absent `byFile` pass through (no parse-error
 *     evidence to aggregate).
 *
 * No-op fast path: when no row qualifies for the downgrade, the
 * function returns the input array unchanged so the common case stays
 * cheap. Object identity stable on the no-op path.
 *
 * @param rows - per-rule coverage rows AFTER the per-file parse-error
 *   adjustment has populated `byFile[]`. Order preserved.
 * @returns adjusted rows (or the input reference when no row qualified).
 */
export function applyCorpusParseErrorRateAdjustment(
  rows: readonly PerRuleCoverage[],
): readonly PerRuleCoverage[] {
  let mutatedAny = false;
  const out = rows.map((row) => {
    const adjusted = adjustRowForCorpusRate(row);
    if (adjusted !== row) mutatedAny = true;
    return adjusted;
  });
  return mutatedAny ? out : rows;
}

/**
 * Per-row adjuster for {@link applyCorpusParseErrorRateAdjustment}.
 * Returns the input row unchanged when the corpus rate doesn't
 * exceed the medium threshold, or when any pass-through guard fires
 * (already-degraded aggregate, skip-reason, sub-threshold eligibility,
 * empty `byFile`).
 *
 * Otherwise returns a fresh row with `coverageConfidence` flipped to
 * `"medium"` or `"low"` per the threshold cascade, plus
 * `coverageConfidenceReason: "corpus-parse-error-rate-above-threshold"`
 * and a `reason` text naming the exact percentage so the agent can
 * triage without re-deriving the ratio.
 *
 * Ratio computation: `byFile.length / filesEligible`. Both fields are
 * already present on the input row by this point in the cascade —
 * `filesEligible` is the rule's pre-adjustment extension-gate match
 * count (unchanged by parse-error adjustment, which only modifies
 * `filesEvaluated`), and `byFile.length` is the parse-error +
 * partial-parse intersection with that gate.
 */
function adjustRowForCorpusRate(row: PerRuleCoverage): PerRuleCoverage {
  if (row.skipReason === "gated_by_level") return row;
  if (row.coverageConfidence !== "high") return row;
  if (row.filesEligible < MIN_ELIGIBLE_FOR_CORPUS_RATE_THRESHOLD) return row;
  const degradedCount = row.byFile?.length ?? 0;
  if (degradedCount === 0) return row;
  const rate = degradedCount / row.filesEligible;
  if (rate < CORPUS_PARSE_ERROR_RATE_MEDIUM_THRESHOLD) return row;
  const newConfidence: "medium" | "low" =
    rate >= CORPUS_PARSE_ERROR_RATE_LOW_THRESHOLD ? "low" : "medium";
  // Reason text quotes the exact percentage so the agent can read the
  // bound additively per the "Numeric-threshold heuristics are
  // suppression" doctrine — the threshold flips the aggregate, but
  // the rate itself stays visible. Rounded to one decimal place to
  // keep the wire output stable across runs (12.4% won't drift to
  // 12.398765432% across floating-point noise).
  const ratePct = (rate * 100).toFixed(1);
  const reason = `${degradedCount} of ${row.filesEligible} eligible files (${ratePct}%) failed to parse or parsed partially`;
  return {
    ...row,
    coverageConfidence: newConfidence,
    coverageConfidenceReason: "corpus-parse-error-rate-above-threshold",
    reason,
  };
}
