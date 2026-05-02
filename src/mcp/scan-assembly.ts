/**
 * Scan-response assemblers — the `plan` and `meta` block builders
 * consumed by `runScanAndFormat`. Extracted so tools-helpers.ts stays
 * under the 500-line budget and the honest-shape rules
 * (conditional-spread on zero counts, split mechanical vs guidance
 * fixes, separate actionable-vs-untargeted manual counters, per-scan
 * `limitations` prose) live next to the shape they describe.
 */

import { classifyFragment } from "../engine/layout-partial.ts";
import {
  partitionPerRuleCoverage,
  type RulesNotEvaluatedDueToInputType,
} from "../engine/per-rule-coverage.ts";
import type { ParsedFile } from "../engine/scanner.ts";
import type { DiscoveryDiagnostics } from "../input/discover.ts";
import { scssVariableDeclarationsLikelyUnresolved } from "../input/parsers/scss-internals.ts";
import type { FixesByClass } from "../output/agent-response/index.ts";
import type { HtmlDocument } from "../types/ast.ts";
import type { ConfigPreset } from "../types/config.ts";
import type { ReviewCandidate } from "../types/review.ts";
import type { FixClass, Rule } from "../types/rule.ts";
import type { PerRuleCoverage, Violation } from "../types/violation.ts";
import { extensionMatches } from "../utils/path.ts";
import { buildAnalysisCoverage } from "./analysis-coverage.ts";
// biome-ignore format: kept on one line for the file-line budget
import { EXTERNAL_HANDLER_RESOLUTION_UNAVAILABLE, shouldSurfaceExternalHandlerLimitation } from "./external-handler-limitation.ts";
import { capMetaArray, type MetaArrayTruncationSummary } from "./meta-array-cap.ts";
import { buildRulesEvaluated } from "./rules-evaluated.ts";
import { splitFixesByClassByScanKind } from "./scan-assembly-fixes-by-scan-kind.ts";
import { suppressionsMetaBlock } from "./suppression-audit.ts";
import type { ResolvedWrapperSources } from "./wrappers-meta.ts";
import { wrappersMetaBlock } from "./wrappers-meta.ts";

// Re-export the helper's surface so callers already importing from
// `scan-assembly.ts` keep one entry point.
// biome-ignore format: kept on one line for the file-line budget
export { EXTERNAL_HANDLER_RESOLUTION_UNAVAILABLE, shouldSurfaceExternalHandlerLimitation } from "./external-handler-limitation.ts";
// Re-export from `./findings-by-file.ts` — same file-size-budget split
// rationale as the linked-stylesheet detector above. Keeps callers
// stamping `plan.findingsByFile` next to `withTopRules` on one import.
// biome-ignore format: kept on one line for the file-line budget
export { computeFindingsByFile, FINDINGS_BY_FILE_DEFAULT_LIMIT, type FindingsByFileEntry, withFindingsByFile } from "./findings-by-file.ts";
// Re-export the linked-stylesheet detector + its result shape so call
// sites that already import from `scan-assembly.ts` (response-assembler,
// scan-time-warnings, tool-scan-project) keep one canonical entry
// point for "things assembled at the scan-meta seam." The detector
// lives in `./linked-stylesheets.ts` to keep this orchestrator under
// the file-size budget — same split pattern as the analysis-coverage
// helpers extracted into `./analysis-coverage-*.ts`.
export {
  detectLinkedStylesheetsNotResolvedForContrast,
  type LinkedStylesheetsUnresolvedForContrast,
} from "./linked-stylesheets.ts";
// Re-export from `./top-directories.ts` — same file-size-budget split
// rationale as findings-by-file. Keeps callers stamping
// `plan.topDirectories` next to `withTopRules` and `withFindingsByFile`
// on one import — the three rank-ordered headline-rollup helpers.
// biome-ignore format: kept on one line for the file-line budget
export { computeTopDirectories, TOP_DIRECTORIES_DEFAULT_LIMIT, type TopDirectoryEntry, withTopDirectories } from "./top-directories.ts";

/**
 * Packs the `plan` block for `ScanFormatted`. Downstream tool handlers
 * consume the result verbatim — the `limitations` prose, the
 * `actionableManualItems`/`untargetedCriteria` split, and the honest
 * counters-are-conditional rules all live here so every callable
 * surface (scan, scan_file, scan_project, scan_diff) emits the same
 * shape without re-stating the rules.
 */
export function buildScanPlan(args: {
  readonly violations: number;
  readonly notes: number;
  readonly violationsWithoutAnyFix: number;
  readonly actionableManual: number;
  readonly untargetedCriteria: number;
  /**
   * Per-{@link FixClass} tally surfaced as the structured sibling
   * `plan.fixesByClass`. Replaces the former `guidanceFixesAvailable`
   * headline, which summed four categorically different lanes under
   * one label — see `src/output/agent-response/build-plan.ts` for the
   * rationale and `docs/kb/architecture/ai-first-consumer.md`
   * "Composite headline counts are dishonest." Always present on the
   * response (zero-count lanes surface as `0` so consumers never have
   * to disambiguate "absent" from "zero").
   *
   * Agents that want the former `safeEditsAvailable` slice (violations
   * whose `fixPaths.primary.edit` is populated — apply-fix can
   * batch-apply them without a round-trip) sum
   * `fixesByClass.mechanical + fixesByClass.verifyInSource`. The
   * composite was dropped per
   * Q-SHARED-SAFE-EDITS-VS-MECHANICAL-DISAGREEMENT: it sat next to
   * `fixesByClass.mechanical` under a name that framed as "how many
   * fixes an agent can apply" and disagreed with the per-lane
   * mechanical count by up to 18× on real responses, forcing the agent
   * to choose which number to trust. The structured per-lane tally
   * answers both questions honestly without the composite.
   */
  readonly fixesByClass: FixesByClass;
  /**
   * Per-rule coverage rows from this scan. When any row carries the
   * cross-file listener-resolution reason (see
   * {@link shouldSurfaceExternalHandlerLimitation}), the structured
   * code {@link EXTERNAL_HANDLER_RESOLUTION_UNAVAILABLE} is appended
   * to `plan.limitations[]` so the agent reads the response-level
   * pointer alongside the prose disclaimers without having to walk
   * `meta.perRuleCoverage[]` to learn the same fact. Optional — when
   * undefined, no structured code is appended (legacy callers,
   * fixtures).
   */
  readonly perRuleCoverage?: readonly PerRuleCoverage[];
}): Record<string, unknown> {
  // biome-ignore format: kept on one line for the file-line budget
  const { violations, notes, violationsWithoutAnyFix, actionableManual, untargetedCriteria, fixesByClass, perRuleCoverage } = args;
  // `fixesByClass` is meaningful only when the scan actually produced
  // violations to bucket — emitting an all-zeros tally on a clean scan
  // is noise that forces the agent to read a field whose only signal
  // is "no violations." Conditional-spread per "Ambiguous field shapes
  // are dishonest" keeps the present-when-meaningful shape honest.
  const emitFixesByClass = violations > 0;
  // `totalFindings` was removed — it summed severity-distinct lanes
  // (violations + info-severity notes) under a single composite
  // headline and inflated the work an agent budgeted against.
  //
  // `safeEditsAvailable` was removed for the same reason
  // (Q-SHARED-SAFE-EDITS-VS-MECHANICAL-DISAGREEMENT): it summed the
  // two editable `fixClass` lanes (mechanical + verify-in-source)
  // under a single headline and disagreed with the per-lane
  // `fixesByClass.mechanical` counter sitting next to it. The
  // structured `fixesByClass` sibling carries the honest per-lane
  // signal; callers that want the apply-now subset sum
  // `fixesByClass.mechanical + fixesByClass.verifyInSource` — which
  // the agent can read directly off the structured tally without
  // needing a second overlapping composite on the wire.
  //
  // `violations` (the flat error+warning count) was removed for the
  // same reason: it summed all four
  // `fixesByClass` lanes (mechanical + verify-in-source + guidance
  // + runtimeOnly) under a single headline, and agents budgeted
  // against the composite as if every entry were an actionable
  // edit. Per `docs/kb/architecture/ai-first-consumer.md` "Composite
  // headline counts are dishonest" the structured `fixesByClass`
  // sibling carries the honest per-lane signal; callers that want
  // the flat error+warning total sum the four lanes themselves.
  // The composite was deleted (not renamed to `violationsComposite`)
  // because a renamed-but-retained sibling still occupies the
  // "first thing the agent reads" slot — the silent-miss failure
  // mode is identical, so deletion is the durable answer.
  //
  // `summary` (the human-readable prose blurb) was removed for the
  // same reason: it embedded 5+ counts (per-lane fixClass tally,
  // notes, actionable manual review, untargeted criteria) duplicating
  // structured siblings (`fixesByClass`, `notes`, `actionableManualItems`,
  // `untargetedCriteria`) into a single composite sentence the agent
  // would read first. Two surfaces (the prose and the structured
  // tally) framed as "how many of X" disagree silently whenever the
  // numbers drift between assembly steps, and an agent budgeting
  // against the prose first never notices. Per the deletion-not-
  // renaming precedent on `plan.totalFindings` /
  // `plan.safeEditsAvailable` / `plan.violations`, the durable answer
  // is to drop the field; consumers that want a human-readable
  // headline stitch one together from the structured siblings
  // themselves.
  //
  // `violationsByScanKind` is stamped one layer up by
  // {@link withViolationsByScanKind} (called from `tool-scan-project.ts`
  // after the build-artifact classifier resolves) — the split between
  // `source` and `buildArtifact` lanes needs the vendor path set,
  // which is only available post-classification. The per-kind
  // structured tally is itself a valid honest split (not a
  // composite); consumers that need to know "of these N, how many
  // sit in vendor code" read the structured `violationsByScanKind`
  // sibling.
  //
  // `violations` is still consumed inside this function (for the
  // `emitFixesByClass` gate above) but is NOT emitted onto the wire
  // — it's the upstream count the consumer-visible `fixesByClass`
  // sums to, kept local-only so the public shape stays honest.
  return {
    notes,
    ...(emitFixesByClass ? { fixesByClass } : {}),
    ...(violationsWithoutAnyFix > 0
      ? { violationsWithoutSuggestion: violationsWithoutAnyFix }
      : {}),
    actionableManualItems: actionableManual,
    untargetedCriteria,
    limitations: [
      "Static analysis can prove failure but not conformance: a clean scan is necessary, not sufficient. Do not claim WCAG conformance on this result alone.",
      "Runtime-only checks — live-region announcements, focus traps, ARIA state transitions, post-render contrast — are out of scope here.",
      // Structured code — appended only when this scan's per-rule
      // coverage observed a cross-file listener-resolution candidate
      // (i.e. a `crossFileCapable: false` rule downgraded its row with
      // `cross_file_listener_resolution_not_attempted_by_rule`). The
      // code rides as a third entry alongside the prose disclaimers
      // because the field's semantic is uniform: "things the agent
      // should know about scan limitations." The kebab-case shape
      // distinguishes structured codes from prose; the gotcha doc at
      // docs/kb/gotchas/cross-file-handler-resolution.md names this
      // contract. Present-when-meaningful per
      // docs/kb/architecture/ai-first-consumer.md "Ambiguous field
      // shapes are dishonest" — when no row carries the predicate the
      // entry is omitted entirely (never an empty placeholder).
      // biome-ignore format: kept on one line for the file-line budget
      ...(shouldSurfaceExternalHandlerLimitation(perRuleCoverage) ? [EXTERNAL_HANDLER_RESOLUTION_UNAVAILABLE] : []),
    ],
  };
}

/**
 * Computes the set of file paths from which ANY scanner output emerged
 * — violations OR review candidates. Drives the
 * `analysisCoverage.parseErrorFiles` vs `partialParseFiles` split in
 * {@link buildAnalysisCoverage}: the doctrine for the former is
 * "no findings emerged" (CLAUDE.md §1 "Ambiguous field shapes are
 * dishonest"), so a file that emitted a grounded review candidate from
 * a source-text-driven finder (e.g. `review/timing` regex-scanning
 * `ctx.source` even when the AST parse failed) MUST land in
 * `partialParseFiles`. Building the set from violations alone — the
 * historical bug under — left
 * such files in `parseErrorFiles`, which agents read as
 * "invisible-to-rules"; downstream triage of the live grounded
 * candidates was silently misled.
 *
 * Distinct from the `findingFilePaths` argument {@link applyParseErrorAdjustment}
 * consumes — that one is per-rule and stays violation-only because
 * review candidates are emitted by finders, not rules; downgrading a
 * rule's `coverageConfidence` on the strength of a finder's output
 * would be unfounded. The two sets coincide on most scans (a finder
 * almost always shares its file with at least one rule emit), but
 * the small mixed-signal cases are exactly where the dishonesty bites.
 */
export function outputFilePathSet(
  violations: readonly Violation[],
  reviewCandidates: readonly ReviewCandidate[],
): Set<string> {
  const out = new Set<string>();
  for (const v of violations) out.add(v.location.filePath);
  for (const c of reviewCandidates) out.add(c.location.filePath);
  return out;
}

/**
 * Packs the `meta` block for `ScanFormatted`. Tool handlers layer the
 * response-level fields (scanned, scanMode, configSource, etc.) on
 * top — this helper only emits the scan-derived fields every caller
 * shares. Returns a plain record so callers can spread additional keys
 * at the usage site.
 */
export function buildScanMeta(args: {
  readonly filesScanned: number;
  /**
   * Count of scanned files where at least one per-file rule was
   * evaluated (extension gate matched, or the rule had no extension
   * constraint). Threaded from {@link import("../engine/scanner.ts").ScanProducts.filesWithAnyRuleEvaluated}.
   * Pairs with `filesScanned` to produce the honest split:
   * `filesScanned` (corpus size) >= `filesWithAnyRuleEvaluated` (rule
   * reach) >= `filesWithZeroRuleEvaluation` (`filesScanned − filesWithAnyRuleEvaluated`,
   * derived here). Per `docs/kb/architecture/ai-first-consumer.md`
   * "Composite headline counts are dishonest": the headline
   * `filesScanned` stays; the new fields split the kind, not replace
   * it. Optional so the legacy single-call sites in tests / fixtures
   * that build meta directly stay landable; production code
   * (`scan_project`, `scan_file`, `coverage`, `checklist`) always
   * threads it from the scanner output.
   */
  readonly filesWithAnyRuleEvaluated?: number;
  readonly files: readonly ParsedFile[];
  readonly activeRules: readonly Rule[];
  readonly durationMs: number;
  readonly enabledStandards: readonly string[];
  readonly wrappers: readonly string[];
  readonly sessionOnly: readonly string[];
  readonly unusedWrappers: readonly string[];
  readonly wrapperProvenance: ResolvedWrapperSources["bySource"];
  readonly wrapperElements: Readonly<Record<string, string>>;
  readonly verboseMeta: boolean;
  readonly preset: ConfigPreset | undefined;
  readonly suppressions: Parameters<typeof suppressionsMetaBlock>[0];
  readonly perRuleCoverage: readonly PerRuleCoverage[];
  /**
   * Discovery diagnostics. When the `skippedByExtension` map is
   * non-empty, it surfaces in `analysisCoverage.skippedByExtension`
   * AND the response-level warning channel fires either
   * `text_source_skipped` (text-source extensions present) or
   * `binary_assets_skipped` (binary extensions present) — the two
   * codes fire independently and can co-exist. Each ships a dense
   * summary payload under
   * `warningsDetails.text_source_skipped` / `warningsDetails.binary_assets_skipped`
   * (`topExtension`, `topCount`, `totalSkipped`, top-N `extensions`)
   * so an agent branching on the bare-string `warnings[]` channel can
   * answer "how bad, and in what kind of code?" per kind without
   * cross-referencing `meta`. Omitted = the caller didn't run discovery
   * (e.g. `scan_file` takes explicit paths) or no files were skipped
   * by the extension check.
   */
  readonly discoveryDiagnostics?: DiscoveryDiagnostics;
  /**
   * Set of file paths from which ANY scanner output emerged — violations
   * (including info-severity notes) OR review candidates. Threaded to
   * {@link buildAnalysisCoverage} so parse-error files can be split
   * into total-failure (`parseErrorFiles` — zero output emitted) and
   * partial-parse (`partialParseFiles` — rules / finders produced output
   * on the recovered slice) buckets. Use {@link outputFilePathSet} to
   * compute it from the scan's violations + review-candidate arrays —
   * the union semantic is load-bearing per-
   * MIXED-SIGNAL (a file with grounded review candidates but zero
   * violations must NOT land in the "invisible-to-rules" bucket).
   * Omitted = caller hasn't wired output yet, in which case every
   * errored file routes into `parseErrorFiles` (historical behavior —
   * safe default, never silently demotes).
   */
  readonly findingFilePaths?: ReadonlySet<string>;
}): Record<string, unknown> {
  const {
    filesScanned,
    filesWithAnyRuleEvaluated,
    files,
    activeRules,
    durationMs,
    enabledStandards,
    wrappers,
    sessionOnly,
    unusedWrappers,
    wrapperProvenance,
    wrapperElements,
    verboseMeta,
    preset,
    suppressions,
    perRuleCoverage,
    discoveryDiagnostics,
    findingFilePaths,
  } = args;
  // File-reach split. The headline `filesScanned` stays — what the
  // scan consumed as input. `filesWithAnyRuleEvaluated` tells the
  // agent how many of those files at least one per-file rule
  // actually evaluated; `filesWithZeroRuleEvaluation` is the
  // complement (the file-shapes the active rule set could not
  // address — canonical case: `.scss` + plain `.js` in a corpus
  // where the active rules target HTML/TSX). Both ride only when
  // the producer threaded `filesWithAnyRuleEvaluated`; legacy
  // call sites that don't (e.g. fixture meta-builders) stay
  // unchanged. Per `docs/kb/architecture/ai-first-consumer.md`
  // "Composite headline counts are dishonest": each top-level
  // counter names exactly one kind of thing.
  const fileReachSpread =
    typeof filesWithAnyRuleEvaluated === "number"
      ? {
          filesWithAnyRuleEvaluated,
          filesWithZeroRuleEvaluation: Math.max(0, filesScanned - filesWithAnyRuleEvaluated),
        }
      : {};
  // Q-SHARED-META-ARRAY-BUDGET-CAP: `buildAnalysisCoverage` returns
  // `{ analysisCoverage?, metaArrayTruncated? }` — we spread only the
  // coverage block onto the wire (the per-array `*Truncated` siblings
  // inside that block are the load-bearing signal). The bare
  // `metaArrayTruncated` bit is an internal signal surfaced separately
  // by callers that need to emit the `response_meta_truncated`
  // warning code; at this seam it's derived on-demand from the
  // materialized coverage block via {@link anyMetaArrayTruncated}.
  const coverageResult = buildAnalysisCoverage(
    files,
    wrappers,
    activeRules,
    verboseMeta,
    wrapperProvenance.fromAutoDetect.confirmed.length,
    preset,
    discoveryDiagnostics,
    findingFilePaths,
  );
  return {
    filesScanned,
    // Honest-shape file-reach telemetry. Surfaces alongside the
    // headline so the agent reads in one pass how much of the
    // corpus was a no-op. Omitted when the producer didn't thread
    // `filesWithAnyRuleEvaluated` (older call sites). See the
    // comment on the destructured local for the doctrine link.
    ...fileReachSpread,
    // Per-extension counts build confidence that the scan actually saw
    // the file types agents expect (e.g., "0 .css scanned" is a red
    // flag if the repo has CSS). Cheap to compute, sorted for
    // determinism.
    filesByExtension: countByExtension(files),
    // Honest-shape rules-evaluated telemetry. Before
    // this was a single number that read
    // as "rules that ran" but actually counted every loaded /
    // post-standard-filter rule regardless of whether it had any
    // eligible inputs in the scan. Per CLAUDE.md §1 "Composite headline
    // counts are dishonest," the field now splits into three
    // monotone-ordered sub-counters (`loaded >= withEligibleInputs >=
    // fired`) derived from `activeRules` + `perRuleCoverage`. Agents
    // reading "52 loaded, 18 had eligible inputs, 9 fired" can budget
    // honestly against the work the scan actually surfaced instead of
    // the composite ceiling.
    rulesEvaluated: buildRulesEvaluated({
      loadedCount: activeRules.length,
      perRuleCoverage,
    }),
    durationMs: Math.round(durationMs),
    standards: [...enabledStandards].sort(),
    ...wrappersMetaBlock({
      sessionOnly,
      unusedWrappers,
      wrapperProvenance,
      wrapperElements,
    }),
    // Honest meta about what static analysis couldn't reach, so the
    // agent can calibrate confidence in "automated clean." Each entry
    // is a structural gap, not a heuristic guess — fields are
    // empty/omitted when there's nothing to report.
    ...(coverageResult.analysisCoverage === undefined
      ? {}
      : { analysisCoverage: coverageResult.analysisCoverage }),
    // Audit trail for every in-source `ra11y-disable` pragma — keeps
    // suppressions visible and accountable. Omitted when no pragmas
    // exist in any scanned file.
    ...suppressionsMetaBlock(suppressions),
    // Per-rule evaluation telemetry for extension-gated rules. Low-
    // confidence rows carry a `reason` + `remediation` so an agent can
    // act on the gap (canonical case: Tailwind pre-build where
    // `contrast/minimum` runs on 0 eligible CSS files and the headline
    // 0 findings is meaningless without this context). The rows
    // arriving here have already been routed through
    // {@link applyParseErrorAdjustment} by the wiring layer when
    // parse-error / partial-parse files exist, so the meta and the
    // top-level `ruleCoverage` derivative agree on
    // `coverageConfidence` for every row (no cross-surface drift).
    //
    // extension-gated rows
    // with `filesEvaluated === 0 && filesEligible === 0` are rolled up
    // into the sibling `rulesNotEvaluatedDueToInputType` counter rather
    // than each shipping ~200 chars of identical "no files matching .css
    // were scanned" boilerplate. On an HTML-only scan over a Tailwind
    // project ~30 of ~70 entries fit this shape; the collapsed counter
    // names the same actionable signal (which extensions the scan never
    // saw) so the agent reads `byExtension` once and decides whether to
    // widen scope. Level-gated rows
    // and project-scoped rows are NOT collapsed — they name orthogonal
    // gaps the agent acts on differently.
    //
    // Doctrine balance — verbose meta is signal, but identical
    // remediation prose repeated across N rules is not telemetry; the
    // collapse preserves what the agent reads (extension to widen) and
    // drops what it skims past (per-rule repetition). Omitted only when
    // both `retained` is empty AND `count` is zero — otherwise the
    // counter rides even at zero so the agent has a deterministic
    // field to read.
    //
    // the full
    // `perRuleCoverage[]` array is the largest per-rule meta block
    // (~250 chars/row × N rules — measured at >40KB on whole-tree
    // scans). It is now gated behind `verboseMeta: true`. At default
    // verbosity the meta carries `perRuleCoverageSummary: { ruleCount,
    // ruleIds }` so cross-tool invariants ("every rule the scanner saw
    // is discoverable via list_rules") still hold and agents triaging
    // a scan can verify rule presence without the per-row payload.
    // The complementary signals — `rulesEvaluated` (loaded /
    // withEligibleInputs / fired counters) and
    // `rulesNotEvaluatedDueToInputType` — stay inline at every
    // verbosity since they are scan-confidence telemetry per the
    // "verbose meta is signal" rule.
    ...perRuleCoverageMetaFragment(perRuleCoverage, activeRules, verboseMeta),
  };
}

/**
 * Builds the spreadable `perRuleCoverage` / `perRuleCoverageSummary` +
 * `rulesNotEvaluatedDueToInputType` meta fragment from the adjusted
 * rows. Extracted so {@link buildScanMeta}'s cognitive complexity
 * stays inside the lint cap and the partition + emit rules live in
 * one place.
 *
 * the full per-rule rows
 * `perRuleCoverage[]` are the largest single meta block — they ride
 * inline only under `verboseMeta: true`. At default verbosity the
 * fragment carries the compact `perRuleCoverageSummary: { ruleCount,
 * ruleIds }` so the canonical "list_rules ⊇ scan.perRuleCoverage rule
 * IDs" invariant still holds and an agent that needs the full
 * per-row payload (parse-error confidence reasons, vendor
 * concentration, cross-file limitation reasons) flips
 * `verboseMeta: true` once. Note the `_Summary` suffix is unique:
 * the field never collides with the verbose `perRuleCoverage` key,
 * and the two are mutually exclusive (the response carries either
 * the array or the summary, never both).
 *
 * `rulesNotEvaluatedDueToInputType` is unconditional — including the
 * zero/empty case — so the agent has a deterministic field to branch
 * on. `perRuleCoverage` is conditional-spread per the existing
 * presence rule (omitted when no rows survive partition);
 * `perRuleCoverageSummary` mirrors that presence so the two surfaces
 * agree on emptiness.
 */
/**
 * Domain-specific cap for `meta.perRuleCoverage[]`. The shared
 * {@link META_ARRAY_CAP}=50 fits path-only entries (`fragmentFiles` at
 * ~60 chars/entry, `scannedBuildArtifacts.ungrouped` at ~110
 * chars/entry); per-rule coverage rows are heterogeneous (~150-400
 * chars/row, averaging ~250) but they ARE the scan-confidence
 * telemetry an agent needs to triage which rules ran on which
 * substrates. A 50-row cap on a 100+-rule registry truncates more
 * than half the registry — the size-vs-signal balance flips against
 * the cap. 200 keeps the full registry visible for the typical
 * project rule fan-out (108 HTML-eligible rules; full registry
 * ~130) while still bounding the worst-case wire impact (200 × 250
 * chars ≈ 50KB) and triggering the head-slice on plugin-heavy
 * configurations that load thousands of rules. Per `docs/kb/
 * architecture/ai-first-consumer.md` "Verbose meta is signal, not
 * clutter" — over-capping per-rule coverage hurts the AI-first
 * consumer more than the wire-size cost it saves.
 */
export const PER_RULE_COVERAGE_CAP = 200;

/**
 * Stable-sort {@link PerRuleCoverage} rows so confidence-degraded rows
 * (low / medium) come before high-confidence rows. Used as the
 * pre-cap step in {@link perRuleCoverageMetaFragment} so the
 * head-slice preserves the rows an agent acts on when the registry
 * exceeds {@link PER_RULE_COVERAGE_CAP}. Within each priority band rows
 * stay in their input order — the engine's per-rule-coverage walk
 * fixes the `list_rules` ⊇ `perRuleCoverage` registry-equivalence
 * invariant on the small-corpus path, and stable sort keeps that
 * invariant intact for the rows that survive the head-slice.
 *
 * Priority ordering (lowest number wins, sorts first):
 *   - 0: `coverageConfidence === "low"` (rule ran but the evidence
 *     horizon was bounded — `parse_failed`, `partial_parse`,
 *     `extension-absent`, `extension-present-but-out-of-scope`).
 *   - 1: `coverageConfidence === "medium"` (rule ran but at a
 *     reduced-confidence band — `scss-unresolved-variables`,
 *     `fragment-input-no-document-envelope`,
 *     `cross_file_*_not_attempted_by_rule`).
 *   - 2: `coverageConfidence === "high"` with non-empty `byFile`
 *     (rule's corpus-level evidence is clean but at least one
 *     specific file's per-file confidence was bounded — Q9 doctrine
 *     "Parser-failure invalidates per-file confidence" applied
 *     per-file, not corpus-wide). The agent reads `byFile` to triage
 *     the bounded files specifically.
 *   - 3: `coverageConfidence === "high"` with no byFile (rule ran on
 *     full evidence — the canonical "ran clean" row, least
 *     informative).
 */
function prioritizePerRuleCoverageForCap(
  rows: readonly PerRuleCoverage[],
): readonly PerRuleCoverage[] {
  const priorityOf = (row: PerRuleCoverage): number => {
    if (row.coverageConfidence === "low") return 0;
    if (row.coverageConfidence === "medium") return 1;
    if (row.byFile !== undefined && row.byFile.length > 0) return 2;
    return 3;
  };
  return [...rows].sort((a, b) => priorityOf(a) - priorityOf(b));
}

/**
 * Spreadable shape returned by {@link perRuleCoverageMetaFragment}. The
 * shared per-rule-coverage helper (`./per-rule-coverage-shared.ts`)
 * re-exports this so the `coverage` tool emits the same wire shape
 * `scan_project` / `scan_file` already produce. Mutually exclusive on
 * `perRuleCoverage` vs `perRuleCoverageSummary`: a response carries one
 * or the other, never both, so an agent reading the meta block doesn't
 * disambiguate two parallel views of the same row set.
 */
export interface PerRuleCoverageMetaFragment {
  readonly perRuleCoverage?: readonly PerRuleCoverage[];
  readonly perRuleCoverageTruncated?: MetaArrayTruncationSummary;
  readonly perRuleCoverageSummary?: {
    readonly ruleCount: number;
    readonly ruleIds: readonly string[];
  };
  readonly rulesNotEvaluatedDueToInputType: RulesNotEvaluatedDueToInputType;
}

export function perRuleCoverageMetaFragment(
  rows: readonly PerRuleCoverage[],
  activeRules: readonly Rule[],
  verboseMeta: boolean,
): PerRuleCoverageMetaFragment {
  const { retained, notEvaluatedDueToInputType } = partitionPerRuleCoverage(rows, activeRules);
  if (retained.length === 0) {
    return { rulesNotEvaluatedDueToInputType: notEvaluatedDueToInputType };
  }
  if (verboseMeta) {
    // Head-slice when the row count crosses the shared meta-array cap.
    // The sibling `perRuleCoverageTruncated: { shown, total }` summary
    // is the in-place sentinel doctrine
    // ("Truncated containers must rename or sentinel, not retain")
    // names — without it, an agent reading a 50-entry array on a
    // corpus whose registry has 130 active rules cannot tell "rule
    // set is 50" from "rule set was clipped to 50." The sibling rides
    // alongside the trimmed array and pairs with the
    // `getTruncatedMetaArrayFields` table entry so
    // `response_meta_truncated` fires AND its
    // `warningsDetails.response_meta_truncated.fields` payload names
    // the dotted path "perRuleCoverage."
    //
    // Prioritization: when the row count exceeds the cap, place
    // confidence-degraded rows (low / medium with a documented reason)
    // before high-confidence rows so the head-slice preserves the
    // signal an agent acts on. A high-confidence row only says "rule
    // ran clean"; a row with `coverageConfidenceReason: "partial-parse"`
    // or `"fragment-input-no-document-envelope"` carries the structured
    // limitation an agent uses to triage whether to scope down. Within
    // each band rows stay in their input order so cross-surface
    // identity (e.g. the order `list_rules` ⊇ `perRuleCoverage` invariant
    // walks) holds when the corpus fits under the cap. Stable sort
    // (Array.prototype.sort in V8/JSC since ES2019) is load-bearing
    // here.
    const prioritized = prioritizePerRuleCoverageForCap(retained);
    const capped = capMetaArray(prioritized, PER_RULE_COVERAGE_CAP);
    return {
      perRuleCoverage: capped.values,
      ...(capped.truncated === undefined ? {} : { perRuleCoverageTruncated: capped.truncated }),
      rulesNotEvaluatedDueToInputType: notEvaluatedDueToInputType,
    };
  }
  // Default verbosity: ship the compact summary. `ruleIds` is sorted
  // (codepoint order) so the field is deterministic across runs.
  return {
    perRuleCoverageSummary: {
      ruleCount: retained.length,
      ruleIds: retained.map((r) => r.ruleId).sort(),
    },
    rulesNotEvaluatedDueToInputType: notEvaluatedDueToInputType,
  };
}

// {@link applyParseErrorAdjustment} + {@link partitionParseStateFiles}
// live in `./parse-error-adjustment.ts` — extracted so this file
// stays under the 500-line budget and the per-rule per-file
// degradation rules (Q9 doctrine: "Parser-failure invalidates
// per-file confidence") sit next to the shape they describe.
// Re-exported here so the historical import path keeps resolving for
// every consumer (the MCP wiring layer + unit tests).
export {
  applyParseErrorAdjustment,
  partitionParseStateFiles,
} from "./parse-error-adjustment.ts";

/**
 * returns the subset of scanned `.scss` files that declare top-level
 * `$variable: …` statements but produced zero literal-color usages
 * downstream after the SCSS preprocessor's substitution pass — the
 * canonical token-only-consumer shape that reads as `findings: []`
 * with `coverageConfidence: "high"` despite the scanner having no
 * contrast evidence to evaluate.
 *
 * Pure over its inputs; runs `scssVariableDeclarationsLikelyUnresolved`
 * on every parsed `.scss` file, then filters out files whose basename
 * matches the Sass declaring-partial convention (`_variables.scss`,
 * `_tokens.scss`, `_colors.scss`/`_colours.scss`, `_theme.scss`,
 * `_vars.scss`) per AI-first doctrine "Heuristic-mislabeled meta
 * sub-fields are dishonest" — a file declaring the variables IS the
 * declaring source, not a downstream consumer that failed to resolve
 * them; listing it as "unresolved against an absent declaring file"
 * lies. The basename match anchors on both signals (leading `_`
 * partial-prefix AND token-vocabulary stem) so a `theme.scss`
 * entry-point stays classified by substitution result.
 *
 * Drives both the `coverageConfidenceReason:
 * "scss-unresolved-variables"` per-rule downgrade
 * ({@link applyScssUnresolvedVariablesAdjustment}) and the top-level
 * `scss_unresolved_variables` warning payload — same file list across
 * surfaces. Returns paths in sorted order; empty array when no files
 * match — callers conditional-spread on `length > 0`.
 */
// biome-ignore format: keep the regex on one line for the file-line budget
const SCSS_DECLARING_PARTIAL_RE = /(?:^|[/\\])_(?:variables|vars|tokens|colors|colours|theme)\.scss$/i;
export function detectScssUnresolvedVariableFiles(files: readonly ParsedFile[]): readonly string[] {
  const out: string[] = [];
  for (const file of files) {
    if (file.ast.language !== "css") continue;
    if (!file.filePath.toLowerCase().endsWith(".scss")) continue;
    if (SCSS_DECLARING_PARTIAL_RE.test(file.filePath)) continue;
    if (!scssVariableDeclarationsLikelyUnresolved(file.source, file.ast.root)) continue;
    out.push(file.filePath);
  }
  return out.sort();
}

/**
 * Returns the subset of scanned HTML-family files whose parsed root
 * classifies as a fragment per the shared
 * {@link classifyFragment} predicate. Mirrors the predicate
 * {@link buildAnalysisCoverage} uses to populate
 * `meta.analysisCoverage.fragmentFiles[]` so the file list driving the
 * `coverageConfidenceReason: "fragment-input-no-document-envelope"`
 * per-rule downgrade and the file list the agent sees on the meta
 * surface stay identical — same evidence, same shared classifier, no
 * cross-surface drift between rule-side suppression and meta-side
 * telemetry.
 *
 * Returns paths in sorted order so wire output is deterministic across
 * runs. Empty array when no fragment files are present — callers
 * conditional-spread on `length > 0`.
 */
export function detectFragmentFiles(files: readonly ParsedFile[]): readonly string[] {
  const out: string[] = [];
  for (const file of files) {
    if (file.ast.language !== "html") continue;
    const { isFragment } = classifyFragment(
      file.ast.root as HtmlDocument,
      file.source,
      file.filePath,
    );
    if (isFragment) out.push(file.filePath);
  }
  out.sort();
  return out;
}

/**
 * row adjuster — companion of
 * {@link applyParseErrorAdjustment} on a different axis. Downgrades a
 * rule's `coverageConfidence` to `"medium"` with
 * `coverageConfidenceReason: "scss-unresolved-variables"` when at
 * least one of its eligible files is in the unresolved-variables set.
 *
 * Why `"medium"` and not `"low"`: the rule did run, eligibility was
 * met, the file parsed cleanly. The honest signal is "evidence horizon
 * was bounded by the SCSS preprocessor's static-resolution limits" —
 * the same shape as the cross-file-resolution downgrade in ADR 0026.
 * A `"low"` downgrade would conflate this case with the parse-error
 * case (file invisible / partially-parsed), which is a stronger
 * statement than the substrate warrants here.
 *
 * Precedence: when {@link applyParseErrorAdjustment} already dropped a
 * row to `"low"`, this adjuster keeps the existing `"low"` and the
 * existing `coverageConfidenceReason` — parse-error / partial-parse is
 * a stronger signal (file invisible to rules) than
 * unresolved-variables (file parsed; substitution layer was bounded).
 * The two reasons never share a row.
 *
 * No-op fast path: when {@link unresolvedScssFiles} is empty, returns
 * the input array unchanged so the common case stays cheap. Exported
 * so the wiring layer (response-assembler, tools-helpers) can run both
 * adjusters in series and feed the per-rule meta + the top-level
 * `ruleCoverage` derivative the same adjusted view.
 */
export function applyScssUnresolvedVariablesAdjustment(
  rows: readonly PerRuleCoverage[],
  files: readonly ParsedFile[],
  activeRules: readonly Rule[],
  unresolvedScssFiles: ReadonlySet<string>,
): readonly PerRuleCoverage[] {
  if (unresolvedScssFiles.size === 0) return rows;
  const ruleById = new Map<string, Rule>();
  for (const r of activeRules) ruleById.set(r.id, r);
  const unresolvedSet = new Set(unresolvedScssFiles);
  const unresolvedFiles = files.filter((f) => unresolvedSet.has(f.filePath));
  return rows.map((row) =>
    adjustRowForScssUnresolvedVariables(row, ruleById.get(row.ruleId), unresolvedFiles),
  );
}

/**
 * Per-row adjustment helper for {@link applyScssUnresolvedVariablesAdjustment}.
 * Returns the input row unchanged when no unresolved-variable files match
 * the rule's gate, when the row is already at `"low"` (parse-error
 * precedence), or when the row's existing
 * `coverageConfidenceReason` is set to a non-scss reason. Otherwise
 * stamps `coverageConfidence: "medium"` + the structured reason.
 */
function adjustRowForScssUnresolvedVariables(
  row: PerRuleCoverage,
  rule: Rule | undefined,
  unresolvedFiles: readonly ParsedFile[],
): PerRuleCoverage {
  if (row.coverageConfidence === "low") return row;
  if (
    row.coverageConfidenceReason !== undefined &&
    row.coverageConfidenceReason !== "scss-unresolved-variables"
  ) {
    return row;
  }
  const matches = countMatchingFiles(rule, unresolvedFiles);
  if (matches === 0) return row;
  return {
    ...row,
    coverageConfidence: "medium",
    coverageConfidenceReason: "scss-unresolved-variables",
    reason:
      row.reason ??
      "scss variables unresolved — scan the compiled CSS output for full contrast coverage",
  };
}

/**
 * Document-shaped rules whose evidence model assumes the parsed file IS
 * the page — `<html>` root, `<head>`, `<body>`, page-level `<main>` /
 * `<title>` / `lang=` are all in scope. On an HTML fragment (Jekyll
 * `_includes/`, Hugo / Astro / Handlebars partials, raw component
 * templates, README markdown residue) the document envelope is
 * provided by a parent layout the scanner doesn't see, so a clean
 * tally on a fragment is bounded — the parent's `<main>` / `<title>` /
 * `lang=` may satisfy the criterion.
 *
 * The set is sourced from the doctrine bullet "Parser-failure
 * invalidates per-file confidence" in
 * `docs/kb/architecture/ai-first-consumer.md`, which names the same
 * fragment-input case as a peer of the parse-error / partial-parse
 * downgrades. The list is small and stable — these are the canonical
 * page-level rules whose premise is "the file is a complete document"
 * — so a static set in the assembly layer (rather than a flag on the
 * rule type) keeps the engine pure and the doctrine readable in one
 * place. New page-level rules adding here is a one-line edit; the test
 * suite asserts the set covers the document-shaped rules it lists.
 */
const FRAGMENT_DOWNGRADE_RULE_IDS: ReadonlySet<string> = new Set([
  "semantics/landmark-main",
  "semantics/heading-hierarchy",
  "semantics/empty-heading",
  "document/page-titled",
  "document/lang-attribute",
  "parsing/html-has-lang",
  // The dangling-fragment rule omits emission entirely on
  // fragment-classified files because the target id may be supplied
  // by the composing parent layout or a sibling fragment — the
  // predicate "no element with this id exists in the rendered DOM"
  // is structurally unverifiable from one fragment file. Listing it
  // here downgrades `perRuleCoverage[].coverageConfidence` to
  // `medium` with reason `fragment-input-no-document-envelope` so
  // the absence of findings on fragment input is visible as
  // scan-confidence telemetry rather than a silent zero.
  "navigation/in-page-link-fragment-missing",
]);

/**
 * companion of
 * {@link applyParseErrorAdjustment} on the fragment-classification
 * axis. Downgrades a document-shaped rule's `coverageConfidence` to
 * `"medium"` with
 * `coverageConfidenceReason: "fragment-input-no-document-envelope"`
 * when at least one of its eligible files is in
 * `analysisCoverage.fragmentFiles[]` (no `<html>` root, no `<body>`).
 *
 * Why `"medium"` and not `"low"`: the rule did run, eligibility was
 * met, the file parsed cleanly. The honest signal is "evidence horizon
 * was bounded by the substrate's lack of a document envelope" — a
 * peer to the `cross_file_*_resolution_not_attempted_by_rule`
 * ADR-0026 downgrade shape, not the parse-error invisibility shape.
 * A `"low"` downgrade
 * would conflate this case with the parse-error case (file invisible /
 * partially-parsed), which is a stronger statement than the substrate
 * warrants here.
 *
 * Precedence: when {@link applyParseErrorAdjustment} or
 * {@link applyScssUnresolvedVariablesAdjustment} already stamped a
 * non-fragment `coverageConfidenceReason`, this adjuster passes the
 * row through unchanged — those reasons name a stronger substrate-
 * level signal (file invisible / SCSS substitution bounded) than
 * fragment classification, and the two reasons never share a row.
 *
 * No-op fast path: when {@link fragmentFilePaths} is empty, returns the
 * input array unchanged. Exported so the wiring layer
 * (response-assembler, tools-helpers) can run all three adjusters in
 * series and feed the per-rule meta + the top-level `ruleCoverage`
 * derivative the same adjusted view.
 */
export function applyFragmentInputAdjustment(
  rows: readonly PerRuleCoverage[],
  files: readonly ParsedFile[],
  activeRules: readonly Rule[],
  fragmentFilePaths: ReadonlySet<string>,
): readonly PerRuleCoverage[] {
  if (fragmentFilePaths.size === 0) return rows;
  const ruleById = new Map<string, Rule>();
  for (const r of activeRules) ruleById.set(r.id, r);
  const fragmentSet = new Set(fragmentFilePaths);
  const fragmentFiles = files.filter((f) => fragmentSet.has(f.filePath));
  return rows.map((row) => adjustRowForFragmentInput(row, ruleById.get(row.ruleId), fragmentFiles));
}

/**
 * Per-row adjustment helper for {@link applyFragmentInputAdjustment}.
 * Returns the input row unchanged when the rule isn't in
 * {@link FRAGMENT_DOWNGRADE_RULE_IDS} (only document-shaped rules
 * downgrade — every other rule's evidence model is honest on a
 * fragment), when no fragment files match the rule's gate, when the
 * row is already at `"low"` (parse-error precedence), or when the
 * row's existing `coverageConfidenceReason` is set to a non-fragment
 * reason (substrate-level signals win over fragment classification).
 */
function adjustRowForFragmentInput(
  row: PerRuleCoverage,
  rule: Rule | undefined,
  fragmentFiles: readonly ParsedFile[],
): PerRuleCoverage {
  if (!FRAGMENT_DOWNGRADE_RULE_IDS.has(row.ruleId)) return row;
  if (row.coverageConfidence === "low") return row;
  if (
    row.coverageConfidenceReason !== undefined &&
    row.coverageConfidenceReason !== "fragment-input-no-document-envelope"
  ) {
    return row;
  }
  const matches = countMatchingFiles(rule, fragmentFiles);
  if (matches === 0) return row;
  return {
    ...row,
    coverageConfidence: "medium",
    coverageConfidenceReason: "fragment-input-no-document-envelope",
    reason:
      row.reason ??
      "at least one matching file parsed as an HTML fragment (no <html>/<body> root); a parent layout supplies the document envelope this rule's evidence model assumes",
  };
}

/**
 * Counts how many files in `pool` match the rule's
 * `appliesTo.fileExtensions` gate. Project-scoped rules (no extension
 * gate) match every file. Mirrors the engine's `applies()` predicate
 * via the shared {@link extensionMatches} helper so the post-processing
 * uses the same eligibility shape as the rule runner — including the
 * `.jsx → .js` / `.tsx → .ts` alias expansion.
 *
 * Returns 0 when the rule is unknown to the active set; defensive for
 * the rare path where a `perRuleCoverage` row references a rule that
 * was filtered out between scanner-emit and meta-assembly.
 */
export function countMatchingFiles(rule: Rule | undefined, pool: readonly ParsedFile[]): number {
  if (rule === undefined) return 0;
  const extensions = rule.appliesTo?.fileExtensions;
  if (!extensions || extensions.length === 0) return pool.length;
  let n = 0;
  for (const f of pool) {
    const dot = f.filePath.lastIndexOf(".");
    const ext = dot === -1 ? "" : f.filePath.slice(dot);
    if (extensionMatches(ext, extensions)) n += 1;
  }
  return n;
}

/** Tally parseable files by extension — surfaces coverage gaps at a glance. */
function countByExtension(files: readonly ParsedFile[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const f of files) {
    const dot = f.filePath.lastIndexOf(".");
    const ext = dot === -1 ? "(no-ext)" : f.filePath.slice(dot);
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Sum of per-file finding counts across a list of file-bucket entries.
 * Pulled out of `response-assembler.ts` and its shadow copy in
 * `tools-helpers.ts` so every scan-family caller that reconciles the
 * `filesSurface` total against the `plan` / `perRuleCoverage` totals
 * runs the same reduction. Accepts the widest readonly shape that
 * exposes `findings.length` so CLI / MCP / report callers can pass
 * their own bucket types without an adapter.
 */
export function sumFindingsAcrossFiles(
  files: readonly { readonly findings: readonly unknown[] }[],
): number {
  let total = 0;
  for (const f of files) total += f.findings.length;
  return total;
}

/**
 * Sum of `findingsEmitted` across a per-rule-coverage array. Pulled out
 * so consumers avoid re-implementing the reduction every time they
 * reconcile a surface total against the scanner-raw stream.
 */
export function sumFindingsEmitted(rows: readonly PerRuleCoverage[]): number {
  let total = 0;
  for (const r of rows) total += r.findingsEmitted;
  return total;
}

/**
 * Cross-check helper for the
 * `coverage_confidence_uniformly_high_with_parse_errors` warning code.
 *
 * Returns `true` when the assembled per-rule-coverage rows are uniformly
 * `coverageConfidence: "high"` AND no row carries any per-file `byFile`
 * override entries. That shape is the consistency gap the warning
 * names: parse-error files exist (separate predicate at the call site)
 * but every per-rule entry claims full evidence with no per-file
 * degradation, so an agent reading the per-rule layer is silently
 * misled about the substrate.
 *
 * Pure over its inputs — the call site supplies the already-adjusted
 * rows (after {@link applyParseErrorAdjustment} +
 * {@link applyScssUnresolvedVariablesAdjustment} +
 * {@link applyFragmentInputAdjustment} +
 * {@link applyScssPartialInputAdjustment} have run). The check is a
 * one-pass scan; an empty rows array returns `true` (vacuously
 * uniform-high), but the warning emission gates on a non-empty
 * `parseErrorFiles` list at the call site so a clean scan with no rows
 * doesn't fire.
 *
 * Per the AI-first "Parser-failure invalidates per-file confidence"
 * doctrine: a non-empty `byFile` array is the per-file degradation
 * surface that already names which files the rule's confidence was
 * bounded on; only when the adjustment leaves every row at uniform
 * `"high"` with no `byFile` does the consistency gap become invisible
 * to an agent reading the coverage block. Either degradation axis
 * (aggregate `medium`/`low` OR per-file `byFile`) clears the predicate.
 */
export function isPerRuleCoverageUniformlyHigh(rows: readonly PerRuleCoverage[]): boolean {
  for (const row of rows) {
    if (row.coverageConfidence !== "high") return false;
    if (row.byFile !== undefined && row.byFile.length > 0) return false;
  }
  return true;
}

/**
 * Per-scan-kind violation tally surfaced as `plan.violationsByScanKind`
 * on `scan_project` responses. Splits error+warning findings by
 * whether the source file was classified as a deterministic build
 * artifact (compiled CSS, vendor bundle, hashed webpack chunk, etc.)
 * by the {@link ./build-artifacts.ts!collectBuildArtifacts} pass.
 *
 * Why split: an agent reading aggregate finding counts against a
 * vendor-heavy template catalog has no way to tell that 41 of 187
 * findings sit in `css/bootstrap.min.css` — files the user cannot
 * edit, for which the productive triage is a `propose_config`
 * exclude rather than a fix attempt. The honest budget is 146
 * source + 41 buildArtifact, not a flat 187. Per
 * `docs/kb/architecture/ai-first-consumer.md` "Composite headline
 * counts are dishonest" and the 2026-04-24 `plan.totalFindings` /
 * 2026-04-25 `plan.violations` precedents, the per-kind structured
 * tally is the load-bearing surface; consumers that want the flat
 * number sum the two lanes themselves (or sum the four
 * `plan.fixesByClass` lanes — both produce the same total). Each
 * per-kind lane (`source`, `buildArtifact`) names exactly one kind
 * of thing, so the split itself is honest, not composite.
 *
 * Surface-don't-suppress: every violation continues to ride in
 * `files[]` regardless of which lane it lands in — this counter is
 * additive triage signal only. The `kind: "buildArtifact"`
 * classification reuses the existing {@link ScannedBuildArtifact}
 * path set (sha a5b07d28); a
 * violation's file qualifies as `buildArtifact` iff its path is in
 * `vendorPaths`. Everything else — including findings on files the
 * scanner couldn't classify either way — counts as `source` so the
 * default-honest behavior is "the file you wrote." This avoids the
 * silent-miss failure mode where a misclassified vendor file silently
 * routes a real authored-code finding into the dismissable bucket.
 */
export interface ViolationsByScanKind {
  readonly source: number;
  readonly buildArtifact: number;
}

/**
 * Computes {@link ViolationsByScanKind} from per-file finding buckets
 * and the build-artifact path set. Iterates the file entries once,
 * routing each finding into the `buildArtifact` lane when its file
 * path is in `vendorPaths` and the `source` lane otherwise.
 *
 * Severity filter — info-severity findings (`notes` in the plan
 * vocabulary) are excluded from both lanes so the per-kind tally
 * splits the same error+warning axis the structured `plan.fixesByClass`
 * tally counts. Without the filter, a vendor file with one
 * info-severity note would inflate the `buildArtifact` lane and the
 * lanes would sum to `error+warning + notes` instead of just
 * `error+warning` — a cross-surface drift the doctrine explicitly
 * warns against ("composite headline counts are dishonest" applies
 * symmetrically to the per-lane split). Callers that want the
 * per-lane note count read it off `files[]` themselves; encoding it
 * in this helper would re-create the multi-axis composite the split
 * exists to kill.
 *
 * Pure over its inputs; takes a readonly shape that exposes
 * `path` + per-finding `severity` so CLI / MCP / report callers can
 * pass their own bucket types without an adapter. Empty input yields
 * `{ source: 0, buildArtifact: 0 }`; an empty `vendorPaths` set
 * routes every finding into `source` (the no-build-artifacts common
 * case) without per-file work besides the set membership check.
 */
export function splitViolationsByScanKind(
  files: readonly {
    readonly path: string;
    readonly findings: readonly { readonly severity: string }[];
  }[],
  vendorPaths: ReadonlySet<string>,
): ViolationsByScanKind {
  let source = 0;
  let buildArtifact = 0;
  for (const f of files) {
    let count = 0;
    for (const finding of f.findings) {
      if (finding.severity !== "info") count += 1;
    }
    if (vendorPaths.has(f.path)) buildArtifact += count;
    else source += count;
  }
  return { source, buildArtifact };
}

/**
 * Stamps `plan.violationsByScanKind` onto a `plan` record produced by
 * {@link buildScanPlan} AND re-derives `plan.fixesByClass` per-scan-kind
 * so each lane carries the same `{ source, buildArtifact }` axis the
 * cross-lane `violationsByScanKind` aggregate carries.
 *
 * Two transforms ride on the same helper because they both key off
 * `vendorPaths` and the per-file finding buckets — the seam where
 * both are in scope is the post-classifier point in
 * `tool-scan-project.ts` (between the build-artifact pass and
 * `assembleScanProjectResponse`). Conditional-spread per CLAUDE.md §1
 * "Ambiguous field shapes are dishonest": the
 * `violationsByScanKind` aggregate sibling is omitted when no
 * artifacts were classified (the existing `meta.scannedBuildArtifacts`
 * absence already conveys "no artifacts"). The per-lane
 * `fixesByClass` rewrite ALWAYS runs — every lane already ships the
 * `{ source: N, buildArtifact: 0 }` shape upstream from
 * `response-assembler` (which calls `countFixesByClass` with an empty
 * vendor path set), so on a no-artifacts scan the rewrite is a no-op
 * by value. When artifacts ARE classified, the upstream's
 * empty-vendor-path tally is wrong (every finding routed to `source`)
 * and the rewrite restores the honest split.
 *
 * Identity-stable when the rewrite is a no-op (no artifacts), so
 * callers can route through this helper unconditionally without
 * paying for a shallow copy on the common case.
 *
 * Cross-surface invariant: for each scan-kind X,
 * `sum(plan.fixesByClass[*].X) === plan.violationsByScanKind[X]`.
 * Both surfaces filter info-severity findings the same way (the
 * upstream `nonNote` slice in `response-assembler` and the
 * `severity !== "info"` filter inside `splitViolationsByScanKind`),
 * and the per-kind classification is the same path-set membership
 * check, so the equality holds regardless of how the lanes
 * distribute. Pinned by
 * `tests/integration/mcp-scan-project-fixes-by-class-by-scan-kind.test.ts`.
 */
export function withViolationsByScanKind(
  plan: Record<string, unknown>,
  files: readonly {
    readonly path: string;
    readonly findings: readonly { readonly severity: string; readonly fixClass?: string }[];
  }[],
  vendorPaths: ReadonlySet<string>,
): Record<string, unknown> {
  if (vendorPaths.size === 0) return plan;
  // Re-derive `fixesByClass` per-scan-kind from the per-file findings.
  // The upstream `response-assembler` call to `countFixesByClass` ran
  // with an empty vendor-path set (the classifier hadn't run yet), so
  // every lane's `buildArtifact` count was zero by construction. With
  // `vendorPaths` now resolved, we redo the split honestly so each
  // lane carries the same `{ source, buildArtifact }` axis the
  // cross-lane `violationsByScanKind` aggregate carries. The rewrite
  // only runs when artifacts WERE classified (the `vendorPaths.size
  // === 0` short-circuit above) — the no-artifacts common case keeps
  // the upstream tally and the helper stays identity-stable on it.
  const split = splitViolationsByScanKind(files, vendorPaths);
  const fixesByClassRewritten = splitFixesByClassByScanKind(files, vendorPaths);
  const planWithFixesByClass =
    plan["fixesByClass"] === undefined ? plan : { ...plan, fixesByClass: fixesByClassRewritten };
  return { ...planWithFixesByClass, violationsByScanKind: split };
}

// `splitFixesByClassByScanKind` lives in
// `./scan-assembly-fixes-by-scan-kind.ts` so this file stays under
// the 500-line file budget enforced by `scripts/check-limits.ts`.

/**
 * Default cap for the {@link computeTopRules} headline rollup. Bulk-
 * scan repros (≈1800 file-with-finding catalogs) made the agent page
 * through every file just to learn which rules dominated; ten is the
 * empirical cut-off where the long tail flattens into per-file
 * idiosyncrasies. Callers can override per-tool, but ten is the
 * scan-project default and the size every test fixture pins.
 */
export const TOP_RULES_DEFAULT_LIMIT = 10;

/**
 * One entry on `plan.topRules` — the cross-file rule-frequency
 * rollup surfaced at the response top level so an agent reading the
 * headline can tell which rule produced the most violations without
 * paging through `files[]`. Per-rule {@link topFile} is the densest
 * single file the rule fired on (path-equality on `files[].path`,
 * which is the same form `meta.perRuleCoverage[].concentration.file`
 * uses); omitted only when the rule emitted on no file (a
 * theoretical degenerate case the call site never hits because rule
 * IDs come from per-finding `ruleId` reads).
 *
 * Severity filter — info-severity findings are excluded from the
 * count axis the same way `splitViolationsByScanKind` excludes them:
 * the rollup describes the same error+warning surface the
 * `plan.fixesByClass` headline tallies. Without the filter, an
 * info-only rule (e.g. `wrappers/inferred`) would crowd the top of
 * the list with non-actionable context — the agent reads
 * "{@link AgentPlan.notes}" for that surface separately.
 *
 * `fixClass` mirrors the rule's declared remediation lane (the same
 * value `Violation.fixClass` carries on every per-finding emission)
 * so the agent reading the headline can partition `topRules[]` by
 * remediation lane and reach the per-rule subset of the
 * `plan.fixesByClass.<lane>` headline tally without paging through
 * `files[]` or `referenceGuide.fixDescriptions`. Per AI-first doctrine
 * "Per-call shape must agree with per-class plan tally": when
 * `plan.fixesByClass.mechanical: 14` advertises 14 mechanical
 * findings, the topRules entries carrying `fixClass: "mechanical"`
 * partition the per-rule axis of those 14 findings. Present-when-
 * meaningful: omitted on the (theoretically degenerate) bucket where
 * the rollup observed no findings carrying a `fixClass` token.
 */
export interface TopRule {
  readonly ruleId: string;
  readonly count: number;
  readonly topFile?: string;
  readonly fixClass?: FixClass;
}

/**
 * Computes the rank-ordered top-{@link TOP_RULES_DEFAULT_LIMIT} rule
 * frequency rollup from a per-file findings list. Pure over its
 * inputs; designed for the `plan.topRules` headline on
 * `scan_project`. The pieces (`findingsEmitted` per rule,
 * `concentration.file` for the densest per-rule file) already exist
 * inside `meta.perRuleCoverage`; this helper exposes the same
 * information as a sorted top-N list at the headline so the agent
 * doesn't have to walk the whole `perRuleCoverage` array (every
 * loaded rule produces a row, even rules with zero findings) just
 * to find the dominant lanes.
 *
 * Sort: count descending, then ruleId ascending (alphabetical) for
 * deterministic ordering across runs. Slice to `limit` (default
 * {@link TOP_RULES_DEFAULT_LIMIT}); when fewer than `limit` rules
 * fired, returns all of them (no padding with zero-count rows —
 * those would be a noise-not-signal shape per CLAUDE.md §1
 * "Ambiguous field shapes are dishonest").
 *
 * Severity filter — see {@link TopRule}'s docblock. Info-severity
 * findings are excluded from both the rule count and the per-rule
 * top-file selection so the rollup splits the same error+warning
 * axis the structured `plan.fixesByClass` headline tallies.
 */
export function computeTopRules(
  files: readonly {
    readonly path: string;
    readonly findings: readonly {
      readonly ruleId: string;
      readonly severity: string;
      readonly fixClass?: FixClass;
    }[];
  }[],
  limit: number = TOP_RULES_DEFAULT_LIMIT,
): readonly TopRule[] {
  const tally = tallyTopRules(files);
  const ranked: TopRule[] = [];
  for (const [ruleId, count] of tally.totals) {
    const fileCounts = tally.perFile.get(ruleId);
    const topFile = fileCounts === undefined ? undefined : pickDensestFile(fileCounts);
    const fixClass = tally.fixClass.get(ruleId);
    ranked.push({
      ruleId,
      count,
      ...(topFile === undefined ? {} : { topFile }),
      ...(fixClass === undefined ? {} : { fixClass }),
    });
  }
  // Count desc; ruleId asc tiebreak so the wire shape stays stable
  // across runs even when the underlying scanner reorders discovery.
  ranked.sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId));
  return ranked.slice(0, limit);
}

/**
 * Single-pass walker for {@link computeTopRules}. Builds the
 * per-rule total count, the per-(rule, path) sub-tally that the
 * `topFile` annotation reads from, and the per-rule `fixClass`
 * stamp the {@link TopRule} entry surfaces — in one walk over the
 * input. Pure over its input; extracted so the orchestrator
 * {@link computeTopRules} stays inside the cognitive-complexity cap.
 *
 * Severity filter — info-severity findings are skipped here so both
 * the count axis and the densest-file selection stay aligned with
 * the error+warning surface `plan.fixesByClass` tallies.
 *
 * `fixClass` capture: the rule registry stamps a single `fixClass`
 * onto every emission a rule produces (`Violation.fixClass` is
 * required), so the first observed finding's `fixClass` is the
 * rule's declared lane. Recording the first-seen value is enough —
 * the per-violation suppression-flavored override that
 * `countFixesByClass` re-routes via emission-text predicates lives
 * downstream of the rule's declared lane and is intentionally not
 * surfaced here (the rollup describes the rule's remediation lane,
 * not the per-emission re-route — agents reading
 * `plan.fixesByClass.suppressRecommended` get the per-emission view
 * separately).
 */
function tallyTopRules(
  files: readonly {
    readonly path: string;
    readonly findings: readonly {
      readonly ruleId: string;
      readonly severity: string;
      readonly fixClass?: FixClass;
    }[];
  }[],
): {
  readonly totals: ReadonlyMap<string, number>;
  readonly perFile: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly fixClass: ReadonlyMap<string, FixClass>;
} {
  const totals = new Map<string, number>();
  const perFile = new Map<string, Map<string, number>>();
  const fixClass = new Map<string, FixClass>();
  for (const file of files) {
    for (const finding of file.findings) {
      if (finding.severity === "info") continue;
      const ruleId = finding.ruleId;
      totals.set(ruleId, (totals.get(ruleId) ?? 0) + 1);
      let bucket = perFile.get(ruleId);
      if (bucket === undefined) {
        bucket = new Map<string, number>();
        perFile.set(ruleId, bucket);
      }
      bucket.set(file.path, (bucket.get(file.path) ?? 0) + 1);
      if (finding.fixClass !== undefined && !fixClass.has(ruleId)) {
        fixClass.set(ruleId, finding.fixClass);
      }
    }
  }
  return { totals, perFile, fixClass };
}

/**
 * Picks the densest file from a per-file count bucket — the single
 * path with the highest finding count, ties broken alphabetically
 * for determinism. Used by {@link computeTopRules} to fill in
 * {@link TopRule.topFile}. Returns `undefined` only when the bucket
 * is empty (defensive — callers never hit this branch because the
 * bucket is constructed from observed findings).
 */
function pickDensestFile(fileCounts: ReadonlyMap<string, number>): string | undefined {
  let best: string | undefined;
  let bestCount = -1;
  for (const [path, count] of fileCounts) {
    if (count > bestCount || (count === bestCount && best !== undefined && path < best)) {
      best = path;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Stamps `plan.topRules` onto a `plan` record produced by
 * {@link buildScanPlan}. Conditional-spread per CLAUDE.md §1
 * "Ambiguous field shapes are dishonest": when no error/warning
 * findings emerged on this scan, the rollup would be `[]` — a sentinel
 * that forces the agent to read `plan.topRules` to learn it has
 * nothing to read. Identity-stable when no rules fired, so
 * `tool-scan-project.ts` can route through this helper unconditionally
 * without paying for a shallow copy on the common no-violations path.
 *
 * Designed to run AFTER {@link buildScanPlan} produced the `plan`
 * record but BEFORE the `plan` reaches the wire — `tool-scan-project.ts`
 * calls this once on the full `formatted.files` list (NOT the paged
 * subset) so the rollup describes the whole scan, not the page the
 * caller happened to fetch. The whole-scan framing is what removes
 * the per-file paging cost the rollup exists to address.
 */
export function withTopRules(
  plan: Record<string, unknown>,
  files: readonly {
    readonly path: string;
    readonly findings: readonly {
      readonly ruleId: string;
      readonly severity: string;
      readonly fixClass?: FixClass;
    }[];
  }[],
  limit: number = TOP_RULES_DEFAULT_LIMIT,
): Record<string, unknown> {
  const topRules = computeTopRules(files, limit);
  if (topRules.length === 0) return plan;
  return { ...plan, topRules };
}
