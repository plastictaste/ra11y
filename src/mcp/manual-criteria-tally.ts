/**
 * Single source of truth for the manual-review tally that
 * `scan_project.plan.{actionableManualItems,untargetedCriteriaForProject}`,
 * `coverage[].{summary.actionable.{criteria,emissionsTotal},manualWithCandidates,manualCandidateEmissionsTotal,untargetedCriteriaForProject}`,
 * and `checklist.summary.{actionable.{criteria,emissionsTotal,emissionsAfterCollapse,emissionsReturnedAfterClip},untargetedCriteriaForProject}` all report.
 * (The per-file lane (`scan` / `scan_file`) consumes the same tally
 * but ships under `plan.untargetedCriteriaForFile` so the project-walk
 * vs single-file slice is explicit on the wire — see `buildScanPlan`
 * in `scan-assembly.ts` for the cross-surface rationale.)
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
   * `skipCriteria`. Matches the sum of
   * `scan_project.plan.actionableManualItemsBySource.{source,buildArtifact}`,
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
   * Per-criterion file-path index for the actionable set: maps each
   * actionable criterion ID to the set of file paths that contributed
   * candidates or verify-token findings on this scan. Drives the
   * `actionableManualItemsBySource: { source, buildArtifact }` lane
   * split downstream — the rewrite seam (`withActionableManualItemsBySource`
   * in `scan-assembly.ts`) intersects each criterion's path set against
   * the resolved `vendorPaths`. A criterion contributes to the `source`
   * lane iff at least one of its paths is NOT in `vendorPaths`, and to
   * the `buildArtifact` lane iff at least one of its paths IS in
   * `vendorPaths`; a criterion with paths on both sides counts in both
   * lanes. Per `docs/kb/architecture/ai-first-consumer.md` "Composite
   * headline counts are dishonest" — pre-split, `actionableManualItems`
   * read 1 on a `dist/*.min.css` `scan_file` while every contributing
   * candidate sat on the buildArtifact lane, the same shape the
   * `fixesByClass` per-lane split was created to surface.
   *
   * Empty when {@link ManualCriteriaTally#actionable} is 0.
   */
  readonly actionableCriteriaPaths: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Number of applicable manual criteria with no grounded candidate —
   * the bare-criterion-prompt subset. Matches
   * `scan_project.plan.untargetedCriteriaForProject`,
   * `checklist.summary.untargetedCriteriaForProject`, and
   * `coverage[].untargetedCriteriaForProject` on project-rooted
   * surfaces; the per-file lane (`scan` / `scan_file`) ships the same
   * tally under `plan.untargetedCriteriaForFile`. Scoped to
   * `applicableManualIds` (metadata-manual minus likely-irrelevant
   * minus skip) so the bare-prompt surface stays focused on the WCAG
   * manual-only criteria the rule library can never mechanically
   * check.
   */
  readonly untargeted: number;
}

/**
 * Per-scan-kind tally for {@link ManualCriteriaTally#actionable}.
 * Mirrors {@link import("../output/agent-response/types.ts").FixesByClassLane}'s
 * `{ source, buildArtifact }` shape so consumers reading the per-lane
 * `actionableManualItemsBySource` field on the plan and the per-lane
 * `fixesByClass` siblings see one consistent axis. A criterion whose
 * shipped candidates / verify-token findings span both lanes counts
 * in both — the lanes are not partitions of the criterion set, they
 * answer "in which scan-kind does this criterion have any visible
 * evidence?" Pre-vendor-classification (no caller-supplied vendor
 * path set) every contributor routes to `source` and `buildArtifact`
 * reads 0 — same default semantics as `splitFixesByClassByScanKind`'s
 * empty-vendorPaths behavior.
 */
export interface ActionableManualLane {
  readonly source: number;
  readonly buildArtifact: number;
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
    if (!isVerifyTokenViolation(v)) continue;
    addInScopeCriteria(out, v.criteria, inScopeCriteria, skipCriteria);
  }
  return out;
}

/**
 * Per-criterion file-path index for verify-token violations — the
 * paths-aware sibling of {@link collectVerifyTokenViolationCriteria}.
 * Each qualifying finding records its `location.filePath` against
 * every in-scope, non-skipped criterion it lists. Used by
 * {@link tallyManualCriteriaFromCoverage} to feed the downstream
 * `actionableManualItemsBySource` lane split with the substrate-of-
 * evidence each verify-token contribution sits on.
 */
function collectVerifyTokenCriteriaPaths(
  violations: readonly Violation[],
  inScopeCriteria: ReadonlySet<string>,
  skipCriteria: ReadonlySet<string> | undefined,
): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, Set<string>>();
  for (const v of violations) {
    if (!isVerifyTokenViolation(v)) continue;
    addInScopeCriteriaPaths(out, v.criteria, v.location.filePath, inScopeCriteria, skipCriteria);
  }
  return out;
}

/**
 * Predicate: is this violation a low-confidence verify-token finding?
 * Severity must be in {@link VERIFY_TOKEN_SEVERITY_GATE} (info) AND at
 * least one entry on `couldBeWrongBecause` must be in
 * {@link VERIFY_IN_SOURCE_TOKENS}. Extracted so
 * {@link collectVerifyTokenViolationCriteria} stays under the lint's
 * cognitive-complexity ceiling and so the predicate can be reused
 * elsewhere if a future caller needs to gate on the same shape.
 */
function isVerifyTokenViolation(v: Violation): boolean {
  if (!VERIFY_TOKEN_SEVERITY_GATE.has(v.severity)) return false;
  const reasons = v.couldBeWrongBecause;
  if (reasons === undefined || reasons.length === 0) return false;
  for (const r of reasons) {
    if (VERIFY_IN_SOURCE_TOKENS.has(r)) return true;
  }
  return false;
}

/**
 * Adds each criterion from `criteria` to `out` when it clears the
 * in-scope gate AND is not in `skipCriteria`. Extracted so the
 * verify-token collector stays under the lint's cognitive-complexity
 * ceiling; the inner per-criterion gate is the same shape used by
 * {@link collectCandidateCriteriaPaths} on the candidate axis.
 */
function addInScopeCriteria(
  out: Set<string>,
  criteria: readonly string[],
  inScopeCriteria: ReadonlySet<string>,
  skipCriteria: ReadonlySet<string> | undefined,
): void {
  for (const id of criteria) {
    if (!inScopeCriteria.has(id)) continue;
    if (skipCriteria?.has(id)) continue;
    out.add(id);
  }
}

/**
 * Paths-aware sibling of {@link addInScopeCriteria}: records `path`
 * against each in-scope, non-skipped criterion. Drives the
 * verify-token branch of the per-criterion path index that the
 * `actionableManualItemsBySource` lane split consumes downstream.
 */
function addInScopeCriteriaPaths(
  out: Map<string, Set<string>>,
  criteria: readonly string[],
  path: string,
  inScopeCriteria: ReadonlySet<string>,
  skipCriteria: ReadonlySet<string> | undefined,
): void {
  for (const id of criteria) {
    if (!inScopeCriteria.has(id)) continue;
    if (skipCriteria?.has(id)) continue;
    let bucket = out.get(id);
    if (bucket === undefined) {
      bucket = new Set<string>();
      out.set(id, bucket);
    }
    bucket.add(path);
  }
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
  const candidateCriteriaPaths = collectCandidateCriteriaPaths(
    candidates,
    inScopeCriteria,
    skipCriteria,
  );
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
  const verifyTokenCriteriaPaths = collectVerifyTokenCriteriaPaths(
    filters?.violations ?? [],
    inScopeCriteria,
    skipCriteria,
  );
  const actionableCriteriaPaths = unionCriteriaPaths(
    candidateCriteriaPaths,
    verifyTokenCriteriaPaths,
  );
  const applicableManualIds = collectApplicableManualIds(coverage, applicability, skipCriteria);
  const actionable = actionableCriteriaPaths.size;
  let untargeted = 0;
  for (const id of applicableManualIds) {
    if (!actionableCriteriaPaths.has(id)) untargeted += 1;
  }
  return { applicableManualIds, actionable, actionableCriteriaPaths, untargeted };
}

/**
 * Per-emission tally on the manual-candidate axis (raw, pre-collapse).
 *
 * `groundedByCriterion` mirrors the criteria-axis count
 * ({@link ManualCriteriaTally#actionable}) — distinct criterion IDs
 * with at least one shipped grounded review candidate. `emissionsTotal`
 * is the candidate-axis sibling: the raw per-emission count of
 * candidates the finders produced against the shared in-scope criteria
 * set, BEFORE any cross-file collapse / pagination clip a downstream
 * surface might apply. Two distinct units, named so an agent reading
 * both does not silently treat one count as the other (per
 * `docs/kb/architecture/ai-first-consumer.md` "Sibling fields naming
 * the same concept must use one shape").
 *
 * Cross-surface invariant: the same `(candidates, applicableManualIds,
 * skipCriteria)` inputs must produce the same `emissionsTotal` on
 * `coverage` and `checklist`. The shared helper is the single source of
 * truth so a future surface that re-derives the count locally can't
 * silently drift from the others — closes the manual-candidate cross-
 * surface drift shape where `actionable.candidates` (post-collapse on
 * checklist) and `manualCandidatesTotal` (raw on coverage) shipped
 * under one named concept with up to 187× drift on bulk corpora.
 */
export interface ManualCandidateEmissionsTally {
  /**
   * Distinct criterion IDs with at least one shipped grounded review
   * candidate, scoped to {@link inScopeCriteria} ∖ {@link skipCriteria}.
   * Mirrors {@link ManualCriteriaTally#actionable} on the same inputs;
   * exposed here so callers building per-emission summaries don't have
   * to thread the full `tallyManualCriteriaFromCoverage` flow.
   */
  readonly groundedByCriterion: number;
  /**
   * Raw per-emission tally of review candidates whose `criterionId`
   * is in `inScopeCriteria` and not in `skipCriteria`. NO cross-file
   * collapse, NO pagination clip — this is the canonical pre-transform
   * count both `coverage.summary.actionable.emissionsTotal` and
   * `checklist.summary.actionable.emissionsTotal` agree on. Surfaces
   * that apply downstream transforms (checklist's
   * `collapseRepeatedAcrossFiles` + `collapseAcrossFilesByReason`,
   * pagination clip) ship the post-transform count under a
   * shape-asymmetry-disclosing name (e.g.
   * `emissionsAfterCollapse`); the raw count stays available for
   * cross-surface equality checks.
   */
  readonly emissionsTotal: number;
}

/**
 * Computes the {@link ManualCandidateEmissionsTally} on a raw candidate
 * stream — the single source of truth for `coverage.summary.actionable
 * .emissionsTotal`, `coverage.manualCandidateEmissionsTotal`, and
 * `checklist.summary.actionable.emissionsTotal`. Both `coverage` and
 * `checklist` consume this helper directly so the candidate-axis
 * cross-surface count invariant holds by construction.
 *
 * Filtering matches the candidate-axis branch of
 * {@link tallyManualCriteriaFromCoverage}: a candidate contributes iff
 * its `criterionId` is in `inScopeCriteria` AND not in `skipCriteria`.
 * This is the same gate `collectCandidateCriteriaPaths` applies, so
 * `groundedByCriterion` agrees with the criteria-axis count.
 *
 * Per `docs/kb/architecture/ai-first-consumer.md` "Cross-surface count
 * invariant": every shared cross-tool counter is computed once in a
 * shared helper, and integration tests pin equality on identical cwd.
 */
export function tallyManualCandidateEmissions(
  candidates: readonly ReviewCandidate[],
  inScopeCriteria: ReadonlySet<string>,
  skipCriteria: ReadonlySet<string> | undefined,
): ManualCandidateEmissionsTally {
  const grounded = new Set<string>();
  let emissions = 0;
  for (const c of candidates) {
    if (!inScopeCriteria.has(c.criterionId)) continue;
    if (skipCriteria?.has(c.criterionId)) continue;
    grounded.add(c.criterionId);
    emissions += 1;
  }
  return { groundedByCriterion: grounded.size, emissionsTotal: emissions };
}

/**
 * Splits the {@link ManualCriteriaTally#actionableCriteriaPaths} index
 * into the {@link ActionableManualLane} `{ source, buildArtifact }`
 * tally consumed by `plan.actionableManualItemsBySource`. A criterion
 * routes into the `source` lane iff at least one of its contributing
 * file paths is NOT in `vendorPaths`, and into the `buildArtifact`
 * lane iff at least one of its paths IS in `vendorPaths`. Criteria
 * whose paths span both sides count in both lanes — the headline
 * answers "does this lane have any visible evidence for this
 * criterion?" rather than partitioning the criterion set, mirroring
 * the way `fixesByClass` lanes count violations whose path-set may
 * span both sides without double-counting individual emissions.
 *
 * Empty `vendorPaths` (the default) routes every criterion to the
 * `source` lane, matching the upstream `{ source: N, buildArtifact: 0 }`
 * shape that `splitFixesByClassByScanKind` and
 * {@link ../output/agent-response/build-plan!countFixesByClass} produce
 * on no-vendor scans. Per `docs/kb/architecture/ai-first-consumer.md`
 * "Composite headline counts are dishonest" — the pre-split bare
 * `actionableManualItems` field would read 1 on a `dist/*.min.css`
 * `scan_file` while every contributing candidate sat in the build-
 * artifact lane, forcing the agent to budget against a "1 manual-
 * review item" headline that pointed at zero authored-source
 * evidence.
 */
export function splitActionableCriteriaByLane(
  actionableCriteriaPaths: ReadonlyMap<string, ReadonlySet<string>>,
  vendorPaths: ReadonlySet<string>,
): ActionableManualLane {
  let source = 0;
  let buildArtifact = 0;
  for (const paths of actionableCriteriaPaths.values()) {
    let hasSource = false;
    let hasBuildArtifact = false;
    for (const path of paths) {
      if (vendorPaths.has(path)) hasBuildArtifact = true;
      else hasSource = true;
      if (hasSource && hasBuildArtifact) break;
    }
    if (hasSource) source += 1;
    if (hasBuildArtifact) buildArtifact += 1;
  }
  return { source, buildArtifact };
}

/**
 * Empty-vendor-paths default for `plan.actionableManualItemsBySource` —
 * every actionable criterion routes to `source`, `buildArtifact` reads
 * 0. The post-classification rewrite via
 * {@link import("./scan-assembly.ts").withActionableManualItemsBySource}
 * runs at each tool's call site once `vendorPaths` resolves.
 * Tolerates an `undefined` index so legacy / fixture call sites that
 * don't thread `actionableCriteriaPaths` stay landable.
 */
export function defaultActionableManualLane(
  actionableCriteriaPaths: ReadonlyMap<string, ReadonlySet<string>> | undefined,
): ActionableManualLane {
  return splitActionableCriteriaByLane(
    actionableCriteriaPaths ?? new Map<string, ReadonlySet<string>>(),
    new Set<string>(),
  );
}

/**
 * Unions two `criterionId → fileSet` indexes. Returns the first input
 * reference unchanged when the second is empty (no-op fast path) —
 * the common case (zero verify-token findings) pays nothing. Per-
 * criterion file sets are unioned where both inputs carry the same
 * criterion so a criterion with both candidate-axis and verify-token-
 * axis evidence in different files preserves both file paths in the
 * downstream lane split.
 */
function unionCriteriaPaths(
  a: ReadonlyMap<string, ReadonlySet<string>>,
  b: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, ReadonlySet<string>> {
  if (b.size === 0) return a;
  const out = new Map<string, Set<string>>();
  for (const [id, paths] of a) out.set(id, new Set<string>(paths));
  for (const [id, paths] of b) {
    let bucket = out.get(id);
    if (bucket === undefined) {
      bucket = new Set<string>();
      out.set(id, bucket);
    }
    for (const p of paths) bucket.add(p);
  }
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
 *
 * Exported so cross-surface consumers (e.g.
 * {@link tallyManualCandidateEmissions} callers in `tool-coverage.ts`
 * and `tool-checklist.ts`) can apply the same in-scope gate the
 * criteria-axis tally uses, keeping the candidate-axis count anchored
 * to the same scope.
 */
export function collectInScopeCriteria(
  coverage: readonly PerStandardCoverage[],
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const entry of coverage) {
    for (const cc of entry.criteria) out.add(cc.criterionId);
  }
  return out;
}

/**
 * Per-criterion file-path index across the candidate stream, with
 * `skipCriteria` applied. Records every contributing file path against
 * each criterion so the downstream lane split (`splitActionableCriteriaByLane`)
 * can intersect against `vendorPaths`. Counts criteria for ANY shipped
 * candidate (regardless of metadata-manual classification) — see
 * {@link tallyManualCriteriaFromCoverage} doctrine note for why
 * partial-criterion candidates must contribute to the actionable
 * headline.
 */
function collectCandidateCriteriaPaths(
  candidates: readonly ReviewCandidate[],
  inScopeCriteria: ReadonlySet<string>,
  skipCriteria: ReadonlySet<string> | undefined,
): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, Set<string>>();
  for (const c of candidates) {
    if (!inScopeCriteria.has(c.criterionId)) continue;
    if (skipCriteria?.has(c.criterionId)) continue;
    let bucket = out.get(c.criterionId);
    if (bucket === undefined) {
      bucket = new Set<string>();
      out.set(c.criterionId, bucket);
    }
    bucket.add(c.location.filePath);
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
