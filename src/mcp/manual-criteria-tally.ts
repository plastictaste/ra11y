/**
 * Single source of truth for the manual-review tally that
 * `scan_project.plan.{actionableManualItems,untargetedCriteria}`,
 * `coverage[].{summary.actionable.criteria,manualWithCandidates,untargetedCriteria}`,
 * and `checklist.summary.{actionable,untargetedCriteria}` all report.
 * (Coverage exposes the criteria-axis manual-review count via the
 * structured `summary` block and the `manualWithCandidates` array's
 * length — the redundant top-level scalar `actionableManualItems` was
 * dropped because it duplicated the array's length verbatim, the
 * "Sibling fields naming the same concept must use one shape" failure
 * mode in `docs/kb/architecture/ai-first-consumer.md`.)
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
 * Definitions (shared across all three surfaces):
 *
 *   - `actionable` = count of distinct criterion IDs across the shipped
 *     grounded candidates (modulo any caller-supplied `skipCriteria`).
 *     Counts criteria for ANY shipped candidate — including candidates
 *     for `automatable === "partial"` criteria. Pre-Q13 the count was
 *     filtered down to `applicableManualIds ∩ candidates`, dropping
 *     every partial-criterion candidate from the headline; an agent
 *     reading `actionableManualItems: 0` next to 16 shipped grounded
 *     items hit the silent-miss the AI-first doctrine warns against.
 *
 *   - `untargeted` = applicable manual-only criteria with no shipped
 *     candidate. A criterion is in the "applicable manual" set when
 *     ALL of: metadata `automatable === "manual"`; level rank ≤
 *     `maxLevel`; zero error/warning violations on this scan (fired
 *     metadata-manual criteria route into the failing automated lane);
 *     not `isLikelyIrrelevant` (no media-only criteria on a scan with
 *     no `<video>` / `<audio>`); not in caller-supplied `skipCriteria`.
 *     Stays scoped to metadata-manual because the bare-criterion-prompt
 *     surface is meaningless for partial criteria — those have
 *     automated rules, so "the finder couldn't ground them" doesn't
 *     describe an evidence gap the agent can act on.
 */

import { buildCoverageReport, type PerStandardCoverage } from "../reports/coverage.ts";
import type { ReviewCandidate } from "../types/review.ts";
import type { Standard } from "../types/standard.ts";
import type { ScanResult } from "../types/violation.ts";
import { type Applicability, splitManualCriteria } from "./manual-applicability.ts";

/**
 * Result of a single manual-criteria tally.
 *
 * `applicableManualIds` is exposed so callers that need the underlying
 * set (e.g. to filter review candidates back down to the manual subset
 * for the inline `reviewCandidates` field on `scan_project`) can read
 * the same set the counts were derived from. No need to recompute.
 *
 * Note: the legacy `actionable + untargeted === applicableManualIds.size`
 * invariant no longer holds. `actionable` counts every criterion with at
 * least one shipped grounded candidate (regardless of metadata-manual
 * classification) per Q13-SCAN-FILE-PLAN-VS-REVIEW-CANDIDATES-DISAGREE
 * and the AI-first doctrine "Per-call shape must agree with per-class
 * plan tally" — a scan_file response shipping 16 grounded candidates
 * for partial-automatable criteria (`wcag22:2.4.3` focus-order,
 * `wcag22:1.1.1` redundant-alt-text, `wcag22:3.3.1` error-identification,
 * etc.) used to read `actionableManualItems: 0` because none of those
 * criterion IDs cleared the metadata `automatable === "manual"` filter,
 * forcing the agent to budget against a headline that ignored 16 visible
 * actionable items in the same response. `untargeted` still scopes to
 * applicable manual-only criteria with no candidates so the
 * bare-criterion-prompt count stays semantically distinct.
 */
export interface ManualCriteriaTally {
  /**
   * Criterion IDs that count as "applicable manual review" — passed the
   * `automatable === "manual"` AND `!fired` AND `!isLikelyIrrelevant`
   * AND `!skipCriteria` filter. Downstream consumers may treat as a Set
   * directly. Drives the {@link ManualCriteriaTally#untargeted} count;
   * does NOT gate {@link ManualCriteriaTally#actionable}.
   */
  readonly applicableManualIds: ReadonlySet<string>;
  /**
   * Number of distinct criterion IDs that have at least one shipped
   * grounded review candidate on this scan, modulo any caller-supplied
   * `skipCriteria`. Matches `scan_project.plan.actionableManualItems`,
   * `checklist.summary.actionable.criteria`, and
   * `coverage[].manualWithCandidates.length` so the "criteria with
   * shipped candidates" count agrees across every project-rooted MCP
   * surface. Counts criteria for ANY candidate the scanner emitted —
   * including candidates for `automatable === "partial"` criteria like
   * `wcag22:2.4.3` (focus-order) or `wcag22:1.1.1` (redundant-alt-text).
   * Pre-fix, the count was filtered down to `applicableManualIds ∩
   * candidates`, dropping every partial-criterion candidate from the
   * headline; the agent budgeted against 0 while the response shipped
   * 16 grounded items per Q13-SCAN-FILE-PLAN-VS-REVIEW-CANDIDATES-DISAGREE.
   */
  readonly actionable: number;
  /**
   * Number of applicable manual criteria with no grounded candidate —
   * the bare-criterion-prompt subset. Matches
   * `scan_project.plan.untargetedCriteria`,
   * `checklist.summary.untargetedCriteria`, and
   * `coverage[].untargetedCriteria`. Scoped to `applicableManualIds`
   * (metadata-manual minus likely-irrelevant minus skip) so the
   * bare-prompt surface stays focused on the WCAG manual-only criteria
   * the rule library can never mechanically check.
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
  const skipCriteria = filters?.skipCriteria;
  const inScopeCriteria = collectInScopeCriteria(coverage);
  const candidateCriteria = collectCandidateCriteria(candidates, inScopeCriteria, skipCriteria);
  const applicableManualIds = collectApplicableManualIds(coverage, applicability, skipCriteria);
  const actionable = candidateCriteria.size;
  let untargeted = 0;
  for (const id of applicableManualIds) {
    if (!candidateCriteria.has(id)) untargeted += 1;
  }
  return { applicableManualIds, actionable, untargeted };
}

/**
 * In-scope criterion-ID set: every criterion the coverage report
 * surfaces after standard-filtering and level-filtering. Candidates
 * carry both the active standard's ID AND its `equivalentIds`
 * (canonical case: `media-variants` finder emits both `wcag22:1.2.4`
 * and `wcag21:1.2.4`); without this gate, a single-standard scan
 * (default `wcag22`) would silently double the actionable count by
 * counting equivalent-standard IDs as separate criteria. Coverage's
 * `entry.criteria[]` is the authoritative in-scope set.
 *
 * Level-filter caveat: the set excludes AAA criteria when the caller
 * scopes to `level: "AA"`. Finders themselves don't level-filter, so
 * AAA candidates still ship on `reviewCandidates[]` — the headline
 * reflects only the AA-scoped subset. This matches the pre-Q13
 * behavior; a separate concern from the partial-criterion miss that
 * motivated Q13.
 */
function collectInScopeCriteria(coverage: readonly PerStandardCoverage[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const entry of coverage) {
    for (const cc of entry.criteria) out.add(cc.criterionId);
  }
  return out;
}

/**
 * Distinct in-scope criterion IDs across the candidate stream, with
 * `skipCriteria` applied. Counts criteria for ANY shipped candidate
 * (regardless of metadata-manual classification) — see
 * {@link tallyManualCriteriaFromCoverage} doctrine note for why
 * partial-criterion candidates must contribute to the actionable
 * headline.
 */
function collectCandidateCriteria(
  candidates: readonly ReviewCandidate[],
  inScopeCriteria: ReadonlySet<string>,
  skipCriteria: ReadonlySet<string> | undefined,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const c of candidates) {
    if (!inScopeCriteria.has(c.criterionId)) continue;
    if (skipCriteria?.has(c.criterionId)) continue;
    out.add(c.criterionId);
  }
  return out;
}

/**
 * Applicable manual criterion IDs across every coverage entry — the
 * metadata-manual subset minus likely-irrelevant minus
 * caller-supplied `skipCriteria`. Drives `untargeted` only; the
 * bare-prompt surface is meaningless for partial criteria so
 * `actionable` deliberately uses a broader gate.
 */
function collectApplicableManualIds(
  coverage: readonly PerStandardCoverage[],
  applicability: Applicability,
  skipCriteria: ReadonlySet<string> | undefined,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const entry of coverage) {
    const { applicable } = splitManualCriteria(entry.manualCriteria, applicability);
    for (const id of applicable) {
      if (skipCriteria?.has(id)) continue;
      out.add(id);
    }
  }
  return out;
}
