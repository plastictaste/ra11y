/**
 * Single source of truth for the manual-review tally that
 * `scan_project.plan.{actionableManualItems,untargetedCriteria}`,
 * `coverage[].{criteriaManualReviewRequired,untargetedCriteria}`, and
 * `checklist.summary.{actionable,untargetedCriteria}` all report.
 *
 * Cross-surface drift on these counts is the canonical failure mode the
 * AI-first consumer model warns against (`docs/kb/architecture/ai-first-
 * consumer.md` §"Cross-surface count invariant"). Before this helper
 * existed, each of the three surfaces re-derived the manual set
 * independently:
 *
 *   - `scan_project` filtered by metadata `automatable === "manual"` and
 *     `isLikelyIrrelevant`, but NOT by whether a rule had emitted a
 *     violation against the criterion. A rule that satisfies a
 *     metadata-manual criterion (canonical case:
 *     `color/meaning-by-color-only` satisfying `wcag22:1.4.1`) would
 *     emit a violation AND keep the criterion in the manual queue,
 *     inflating the headline by 1 per fired manual criterion.
 *
 *   - `coverage` and `checklist` both derived their manual list from
 *     `buildCoverageReport(...).manualCriteria`, which DOES exclude
 *     fired-violation criteria (it routes them into the failing lane).
 *
 * The off-by-N drift recorded in the field-test sweep (one scan: 17
 * scan vs 15 coverage vs 15 checklist) was exactly this asymmetry — two
 * fired manual criteria silently dropped on the coverage/checklist side
 * but counted on scan_project. Routing all three surfaces through this
 * helper fixes the drift at the source; an integration test pins the
 * agreement.
 *
 * Definition (shared across all three surfaces): a criterion is in the
 * "applicable manual" set when ALL of:
 *   1. metadata `automatable === "manual"`
 *   2. level rank ≤ `maxLevel`
 *   3. has zero error/warning violations on this scan (a fired manual
 *      criterion is "failing in the automated lane," not "still needs
 *      manual review")
 *   4. not `isLikelyIrrelevant` (no media-only criteria when the scan
 *      saw no `<video>` / `<audio>`)
 * Then `actionable` = subset with at least one grounded review
 * candidate; `untargeted` = subset without.
 */

import { buildCoverageReport, type PerStandardCoverage } from "../reports/coverage.ts";
import type { ReviewCandidate } from "../types/review.ts";
import type { Standard } from "../types/standard.ts";
import type { ScanResult } from "../types/violation.ts";
import { type Applicability, splitManualCriteria } from "./manual-applicability.ts";

/**
 * Result of a single manual-criteria tally. All three counts agree by
 * construction: `actionable + untargeted === applicableManualIds.size`.
 *
 * `applicableManualIds` is exposed so callers that need the underlying
 * set (e.g. to filter review candidates back down to the manual subset
 * for the inline `reviewCandidates` field on `scan_project`) can read
 * the same set the counts were derived from. No need to recompute.
 */
export interface ManualCriteriaTally {
  /**
   * Criterion IDs that count as "applicable manual review" — passed all
   * four filters above. Downstream consumers may treat as a Set
   * directly.
   */
  readonly applicableManualIds: ReadonlySet<string>;
  /**
   * Number of applicable manual criteria a finder grounded in a
   * concrete file:line via at least one review candidate. Matches
   * `scan_project.plan.actionableManualItems`,
   * `checklist.summary.actionable.criteria`, and
   * `coverage[].manualWithCandidates.length`.
   */
  readonly actionable: number;
  /**
   * Number of applicable manual criteria with no grounded candidate —
   * the bare-criterion-prompt subset. Matches
   * `scan_project.plan.untargetedCriteria`,
   * `checklist.summary.untargetedCriteria`, and
   * `coverage[].untargetedCriteria`.
   */
  readonly untargeted: number;
}

/**
 * Inputs the tally needs. Callers that already have a coverage report
 * in hand should prefer {@link tallyManualCriteriaFromCoverage} — it
 * skips re-building the coverage shape and keeps the canonical
 * fired-aware `manualCriteria` source-of-truth in one place.
 */
export interface TallyManualCriteriaInputs {
  readonly standards: readonly Standard[];
  readonly enabledStandards: readonly string[];
  readonly level: "A" | "AA" | "AAA";
  readonly scanResult: ScanResult;
  readonly applicability: Applicability;
  readonly candidates: readonly ReviewCandidate[];
}

/**
 * Tallies the manual-review counts from a fresh scan. Internally builds
 * a coverage report so the canonical fired-aware `manualCriteria`
 * derivation is shared with the `coverage` / `checklist` paths.
 *
 * `buildCoverageReport` is called WITHOUT `testableCriteria` here — the
 * untestable split changes the `clean` / `withFindings` lanes but does
 * not affect `manualCriteria` (the metadata-manual list is independent
 * of rule-input eligibility). Both shapes route fired manual criteria
 * out of the manual lane the same way, so omitting `testableCriteria`
 * keeps this helper independent of `perRuleCoverage` plumbing.
 */
export function tallyManualCriteria(input: TallyManualCriteriaInputs): ManualCriteriaTally {
  const coverage = buildCoverageReport(
    input.scanResult,
    input.standards,
    input.level,
    undefined,
    undefined,
  );
  return tallyManualCriteriaFromCoverage(coverage, input.applicability, input.candidates);
}

/**
 * Optional filters for {@link tallyManualCriteriaFromCoverage}. Lets the
 * `checklist` surface route its caller-supplied `skipCriterion` filter
 * through the shared helper so the counts it surfaces stay derived from
 * the same algorithm `scan_project` and `coverage` use — without
 * forking a parallel "checklist's actionable" definition that would
 * silently drift on real corpora.
 *
 * Cross-surface invariant: when `checklist` is invoked without
 * `skipCriterion` (and `scan_project` / `coverage` never pass one
 * through), the helper produces identical numbers across all three
 * surfaces by construction. With a non-empty set, skipped criteria
 * are subtracted from `applicableManualIds` (and therefore from both
 * `actionable` and `untargeted`) so the count the agent sees matches
 * the items the response surfaces.
 */
export interface TallyManualCriteriaFilters {
  /**
   * Criterion IDs the caller asked to drop from the manual queue.
   * Treated identically to "this criterion was never applicable" —
   * subtracted from `applicableManualIds` before the actionable /
   * untargeted split runs. Empty / undefined = no filter applied.
   */
  readonly skipCriteria?: ReadonlySet<string>;
}

/**
 * Variant for callers that already have a coverage report (`coverage`
 * and `checklist` both build one for their own per-standard counters).
 * Keeps all three surfaces (`scan_project`, `coverage`, `checklist`)
 * walking the same fired-aware list as `scan_project` would compute
 * via {@link tallyManualCriteria} — the cross-surface count invariant
 * doctrine in `docs/kb/architecture/ai-first-consumer.md` makes
 * sharing this single helper load-bearing for every caller.
 *
 * `enabledStandards` filtering is implicit: `buildCoverageReport`
 * already filters by `result.enabledStandards`, so coverage entries
 * passed here only cover the active standards. Callers that pre-filter
 * the coverage array (e.g. multi-standard branch dropping non-target
 * entries) get the same behavior — the helper just iterates whatever
 * entries it receives.
 */
export function tallyManualCriteriaFromCoverage(
  coverage: readonly PerStandardCoverage[],
  applicability: Applicability,
  candidates: readonly ReviewCandidate[],
  filters?: TallyManualCriteriaFilters,
): ManualCriteriaTally {
  const candidateCriteria = new Set(candidates.map((c) => c.criterionId));
  const skipCriteria = filters?.skipCriteria;
  const applicableManualIds = new Set<string>();
  for (const entry of coverage) {
    const { applicable } = splitManualCriteria(entry.manualCriteria, applicability);
    for (const id of applicable) {
      if (skipCriteria !== undefined && skipCriteria.has(id)) continue;
      applicableManualIds.add(id);
    }
  }
  let actionable = 0;
  for (const id of applicableManualIds) {
    if (candidateCriteria.has(id)) actionable += 1;
  }
  const untargeted = applicableManualIds.size - actionable;
  return { applicableManualIds, actionable, untargeted };
}
