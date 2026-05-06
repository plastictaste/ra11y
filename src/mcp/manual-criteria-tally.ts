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
import type { ScanResult, Severity, Violation } from "../types/violation.ts";
import { type Applicability, splitManualCriteria } from "./manual-applicability.ts";

/**
 * Structured `couldBeWrongBecause` codes that frame a finding as
 * "please verify this in source." When a rule's evidence model has
 * conceded the predicate may not hold on this substrate (single-
 * component demo body shape, layout-partial composition, template-
 * interpolated title, runtime DOM mutation) it pairs the concession
 * with severity `info` (→ `confidence: "low"` per the agent-response
 * derivation) AND attaches one of these tokens. The pairing is the
 * rule's way of saying "this is asking you to verify in surrounding
 * context, not a deterministic failure."
 *
 * Per `docs/kb/architecture/ai-first-consumer.md` "Composite headline
 * counts are dishonest," `actionableManualItems` must reflect every
 * candidate-shaped item the response surfaces — including these
 * verify-in-source findings on the violations axis. Pre-fix the
 * counter only walked `reviewCandidates[]`, so a `scan_file`
 * response shipping a `confidence: "low"` `semantics/landmark-main`
 * finding with `couldBeWrongBecause: ["isolated_component_demo_page"]`
 * read as `actionableManualItems: 0` despite explicitly asking the
 * agent to verify the page composition — the canonical silent-miss the
 * doctrine warns against.
 *
 * Membership is curated rather than open-ended: a token earns a slot
 * here only when paired with a rule's severity downgrade to `info`
 * (or another conceded-uncertainty path). Cross-file resolution
 * limitations (`cross_file_listener_resolution_not_attempted_by_rule`,
 * `cross_file_idref_resolution_not_attempted_by_rule`) are NOT in
 * this set — they describe scanner evidence-horizon limitations on
 * findings that still ride at full `error`/`warning` severity, and
 * `per-finding-confidence-parity.ts` already handles their downgrade
 * propagation. Likewise the parser-substrate codes (`file_parse_error`,
 * `partial_parse`, `fragment_input_no_document_envelope`) describe
 * substrate-bounded evidence rather than a "verify the predicate"
 * frame, and the per-rule coverage adjuster already reflects them.
 *
 * The set is keyed on the snake_case codes the rules emit verbatim;
 * see each constant's docblock at the rule's emission site for the
 * predicate that gates it (e.g. `ISOLATED_COMPONENT_DEMO_CODE` in
 * `src/rules/semantics/landmark-main.ts`). Adding a new entry is
 * additive: the cross-surface invariant tests pin `actionable`
 * agreement, so a token added here that didn't actually lower
 * severity to `info` would inflate `actionable` on one surface
 * without the others reading the same finding the same way.
 */
export const VERIFY_IN_SOURCE_TOKENS: ReadonlySet<string> = new Set<string>([
  // semantics/landmark-main — body shape ≤2 children with ≤1 non-script
  // matches an isolated component demo page; rendered page may be
  // composed by a parent layout supplying <main>.
  "isolated_component_demo_page",
  // semantics/landmark-main — probable-main candidate plus zero sibling
  // landmarks; the largest-non-landmark-block ranking depends on
  // rendered layout the static AST cannot observe.
  "largest_block_guess_unobservable",
  // semantics/landmark-main, semantics/heading-hierarchy — scanned file
  // looks like a layout wrapper or template partial; composed page
  // may carry the landmark/heading from a sibling file.
  "partial_or_layout_file_requires_composed_check",
  // semantics/heading-hierarchy, semantics/landmark-main — markdown
  // adapter stripped ATX headings/envelope; visible residue may not
  // represent the rendered page.
  "markdown_atx_headings_stripped_only_html_residue_visible",
  "markdown_residue_no_main_visible",
  // semantics/duplicate-landmark-unlabeled — fragment input lacks the
  // document envelope needed to confirm sibling-landmark duplication
  // is real.
  "partial_input_duplicate_landmark_in_fragment",
  // document/page-titled — title text is template-interpolated or
  // matches a scaffold default; runtime substitution may carry the
  // real title.
  "title_may_be_template_injected",
  "title_is_template_interpolated",
  "title_looks_like_scaffold_default",
  // document/lang-attribute — `lang` attribute lives only inside an IE
  // conditional comment; modern browsers may see no lang.
  "html_lang_only_in_ie_conditional",
  // aria/live-region-missing-on-innerhtml-target — innerHTML target
  // resolves at runtime; static analysis can't confirm the live region
  // wires through the actual mutation site.
  "runtime_innerhtml_population",
  // aria/hidden-focus — runtime aria-hidden toggle observed; the
  // focus-trap predicate depends on render-time state.
  "runtime_aria_hidden_toggle",
  // tooltip/dismissable — JS enhancer may attach the dismissal
  // handler at runtime.
  "tooltip_js_enhancer_present",
]);

/**
 * Severity gate for verify-token violations counted into
 * {@link ManualCriteriaTally#actionable}. Matches the rule emit
 * convention: severity `info` is the conceded-uncertainty branch
 * (downgrade-to-info paired with the verify-token in
 * `couldBeWrongBecause`). `error`/`warning` findings stay on the
 * deterministic-failure axis — the agent reads them through the
 * per-rule label / per-finding `confidence` channels rather than the
 * manual-review tally.
 */
const VERIFY_TOKEN_SEVERITY_GATE: ReadonlySet<Severity> = new Set<Severity>(["info"]);

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
 *
 * `violations` is optional — when supplied, low-confidence verify-token
 * findings (severity `info` with at least one entry from
 * {@link VERIFY_IN_SOURCE_TOKENS} on `couldBeWrongBecause`) contribute
 * their criteria to the {@link ManualCriteriaTally#actionable} count
 * alongside grounded review candidates. See the helper docblock for
 * the doctrine pointer; legacy callers that omit `violations` keep
 * pre-fix behavior (review-candidate axis only).
 */
export interface TallyManualCriteriaInputs {
  readonly standards: readonly Standard[];
  readonly enabledStandards: readonly string[];
  readonly level: "A" | "AA" | "AAA";
  readonly scanResult: ScanResult;
  readonly applicability: Applicability;
  readonly candidates: readonly ReviewCandidate[];
  readonly violations?: readonly Violation[];
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
  return tallyManualCriteriaFromCoverage(coverage, input.applicability, input.candidates, {
    ...(input.violations === undefined ? {} : { violations: input.violations }),
  });
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
  /**
   * Optional violation stream the helper inspects for low-confidence
   * verify-token findings whose criteria should contribute to
   * {@link ManualCriteriaTally#actionable}. A finding qualifies when
   * its severity is `info` AND at least one entry on
   * `couldBeWrongBecause` is in {@link VERIFY_IN_SOURCE_TOKENS}.
   * Criteria from qualifying findings are unioned with grounded
   * review-candidate criteria before the actionable count is taken,
   * so the headline reflects every candidate-shaped item the response
   * surfaces. Omitted / undefined = pre-fix behavior (review-candidate
   * axis only).
   */
  readonly violations?: readonly Violation[];
}

/**
 * Collects the criterion IDs from low-confidence verify-token
 * findings on a violation stream. A finding qualifies when:
 *
 *   - Severity is in {@link VERIFY_TOKEN_SEVERITY_GATE} (currently
 *     `info`, the conceded-uncertainty branch).
 *   - At least one entry on `couldBeWrongBecause` is in
 *     {@link VERIFY_IN_SOURCE_TOKENS}.
 *   - The criterion is in `inScopeCriteria` (mirrors the candidate
 *     axis: filters out cross-standard equivalents the helper's
 *     scope-derivation already excluded).
 *   - The criterion is NOT in `skipCriteria` (caller-supplied filter
 *     subtracts on this axis the same way it does on candidates).
 *
 * Encounter order does not matter: callers union the result with the
 * candidate-criteria set before counting distinct ids.
 *
 * Exported so cross-surface consumers (e.g. coverage's
 * `withCandidates` build, which derives directly from the candidate
 * stream rather than the helper) can apply the same predicate to keep
 * their per-entry `manualWithCandidates` array in lockstep with
 * `summary.actionable.criteria`.
 */
export function collectVerifyTokenViolationCriteria(
  violations: readonly Violation[],
  inScopeCriteria: ReadonlySet<string>,
  skipCriteria: ReadonlySet<string> | undefined,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const v of violations) {
    if (!VERIFY_TOKEN_SEVERITY_GATE.has(v.severity)) continue;
    const reasons = v.couldBeWrongBecause;
    if (reasons === undefined || reasons.length === 0) continue;
    let hasVerifyToken = false;
    for (const r of reasons) {
      if (VERIFY_IN_SOURCE_TOKENS.has(r)) {
        hasVerifyToken = true;
        break;
      }
    }
    if (!hasVerifyToken) continue;
    for (const id of v.criteria) {
      if (!inScopeCriteria.has(id)) continue;
      if (skipCriteria?.has(id)) continue;
      out.add(id);
    }
  }
  return out;
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
  // Q15-LANDMARK-MAIN: low-confidence verify-token findings (severity
  // `info` paired with a code from VERIFY_IN_SOURCE_TOKENS) are the
  // rule's way of saying "please verify this in source." Their
  // criteria union into the actionable axis alongside grounded
  // candidates so the headline reflects every candidate-shaped item
  // the response surfaces — pre-fix a `landmark-main` finding with
  // `couldBeWrongBecause: ["isolated_component_demo_page"]` was the
  // only manual-review item in a `scan_file` response yet
  // `actionableManualItems` read 0, the canonical Composite-Headline-
  // Counts-Are-Dishonest miss. Both directions of the union are
  // additive: a criterion already in `candidateCriteria` doesn't
  // double-count (`Set` union absorbs duplicates), and a criterion
  // appearing only on a verify-token finding (no review candidate)
  // pulls into `actionable` without inflating `untargeted` (it drops
  // out of the bare-prompt subset because a finding IS surfacing it).
  const verifyTokenCriteria = collectVerifyTokenViolationCriteria(
    filters?.violations ?? [],
    inScopeCriteria,
    skipCriteria,
  );
  const actionableCriteria = unionCriteria(candidateCriteria, verifyTokenCriteria);
  const applicableManualIds = collectApplicableManualIds(coverage, applicability, skipCriteria);
  const actionable = actionableCriteria.size;
  let untargeted = 0;
  for (const id of applicableManualIds) {
    if (!actionableCriteria.has(id)) untargeted += 1;
  }
  return { applicableManualIds, actionable, untargeted };
}

/**
 * Unions two criterion-ID sets. Returns the first input reference
 * unchanged when the second is empty (no-op fast path) — the common
 * case (zero verify-token findings) pays nothing.
 */
function unionCriteria(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): ReadonlySet<string> {
  if (b.size === 0) return a;
  const out = new Set<string>(a);
  for (const id of b) out.add(id);
  return out;
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
