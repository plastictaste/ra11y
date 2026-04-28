/**
 * Scan-response assemblers — the `plan` and `meta` block builders
 * consumed by `runScanAndFormat`. Extracted so tools-helpers.ts stays
 * under the 500-line budget and the honest-shape rules
 * (conditional-spread on zero counts, split mechanical vs guidance
 * fixes, separate actionable-vs-untargeted manual counters, per-scan
 * `limitations` prose) live next to the shape they describe.
 */

import { isHtmlFragment } from "../engine/ast-helpers.ts";
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
import type { Rule } from "../types/rule.ts";
import type { PerRuleCoverage, Violation } from "../types/violation.ts";
import { extensionMatches } from "../utils/path.ts";
import { buildAnalysisCoverage } from "./analysis-coverage.ts";
import { isBuildArtifact } from "./build-artifacts.ts";
import { buildRulesEvaluated } from "./rules-evaluated.ts";
import { suppressionsMetaBlock } from "./suppression-audit.ts";
import type { ResolvedWrapperSources } from "./wrappers-meta.ts";
import { wrappersMetaBlock } from "./wrappers-meta.ts";

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
}): Record<string, unknown> {
  const {
    violations,
    notes,
    violationsWithoutAnyFix,
    actionableManual,
    untargetedCriteria,
    fixesByClass,
  } = args;
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
function perRuleCoverageMetaFragment(
  rows: readonly PerRuleCoverage[],
  activeRules: readonly Rule[],
  verboseMeta: boolean,
): {
  readonly perRuleCoverage?: readonly PerRuleCoverage[];
  readonly perRuleCoverageSummary?: {
    readonly ruleCount: number;
    readonly ruleIds: readonly string[];
  };
  readonly rulesNotEvaluatedDueToInputType: RulesNotEvaluatedDueToInputType;
} {
  const { retained, notEvaluatedDueToInputType } = partitionPerRuleCoverage(rows, activeRules);
  if (retained.length === 0) {
    return { rulesNotEvaluatedDueToInputType: notEvaluatedDueToInputType };
  }
  if (verboseMeta) {
    return {
      perRuleCoverage: retained,
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

/**
 * Adjusts {@link PerRuleCoverage} rows so files that failed to parse
 * are honest about whether the rule actually evaluated their content
 *
 * The engine's evaluation tracker bumps `eligible` and `evaluated` per
 * (rule, file) pair purely on extension match — a file in
 * `parseErrorFiles` (parser totally failed, AST is empty) still
 * contributes the same +1 as a clean-parsing file, even though the
 * rule never saw the content. Without correction, an extension-gated
 * rule whose only matching files all failed to parse surfaces as
 * `findingsEmitted: 0, coverageConfidence: "high"` — the canonical
 * silent-miss the doctrine "zero-output success is ambiguous failure"
 * names at per-rule granularity.
 *
 * Two adjustments fire:
 *
 *   - Parse-error files (errored AND zero findings): subtracted from
 *     the row's `filesEvaluated`. When the resulting count is below
 *     `MIN_FILES_FOR_HIGH_CONFIDENCE` (1), confidence drops to `"low"`
 *     and `coverageConfidenceReason: "file-parse-error"` stamps the
 *     structured cause. `filesEligible` is left intact — eligibility
 *     is "matched the gate," which the parse-error file did; the
 *     gap is at evaluation, not eligibility.
 *   - Partial-parse files (errored AND at least one finding):
 *     `filesEvaluated` stays — rules genuinely fired on the recovered
 *     AST — but confidence drops to `"low"` and
 *     `coverageConfidenceReason: "partial-parse"` stamps the cause.
 *     The row's existing `reason` (if any) is preserved alongside,
 *     since it names a different axis (e.g. extension-gate,
 *     cross-file-bound) than the parse-state axis the new field
 *     covers.
 *
 * Project-scoped rules use `filesScanned` as their evaluated count;
 * the same subtraction applies for parse-error files since a project
 * rule running over an empty AST cannot detect anything in that file
 * either.
 *
 * No-op fast path: when no parse-error / partial-parse files matched
 * any rule's gate, the function returns the input array unchanged so
 * the common case stays cheap. Exported so the wiring layer (which
 * also passes `perRuleCoverage` to {@link buildRuleCoverageDerivative})
 * can adjust the rows once and feed both consumers, avoiding cross-
 * surface drift between `meta.perRuleCoverage` and the top-level
 * `ruleCoverage` headline.
 */
export function applyParseErrorAdjustment(
  rows: readonly PerRuleCoverage[],
  files: readonly ParsedFile[],
  activeRules: readonly Rule[],
  findingFilePaths: ReadonlySet<string> | undefined,
): readonly PerRuleCoverage[] {
  const partition = partitionParseStateFiles(files, findingFilePaths);
  if (partition.parseError.size === 0 && partition.partialParse.size === 0) return rows;
  // Re-bind to ParsedFile arrays for the per-row matcher, which gates
  // on `appliesTo.fileExtensions`.
  const parseErrorFiles = files.filter((f) => partition.parseError.has(f.filePath));
  const partialParseFiles = files.filter((f) => partition.partialParse.has(f.filePath));
  const ruleById = new Map<string, Rule>();
  for (const r of activeRules) ruleById.set(r.id, r);
  return rows.map((row) =>
    adjustRowForParseErrors(row, ruleById.get(row.ruleId), parseErrorFiles, partialParseFiles),
  );
}

/**
 * Partitions the scan's parsed files into the two parse-state buckets
 * the per-rule confidence adjuster and the per-finding propagation
 * helper both need:
 *
 *   - `parseError` — files where the parser errored AND no rule / finder
 *     emitted any output. These contribute to the `file-parse-error`
 *     reason on the per-rule coverage row.
 *   - `partialParse` — files where the parser errored AND at least one
 *     rule / finder emitted output (the recovered AST was usable).
 *     These contribute to the `partial-parse` reason.
 *
 * Build-artifact files are excluded from both buckets — their phantom
 * parse errors are suppressed from `meta.analysisCoverage.parseErrorFiles[]`
 * elsewhere, so any per-rule / per-finding confidence downgrade keyed
 * off the same predicate must agree.
 *
 * Exported so the per-finding propagation helper can gate
 * `file_parse_error` / `partial_parse` codes on file membership: a
 * substrate code attached to a finding whose file is NOT in either
 * bucket reads as "the file's parser failed" when the finding's file
 * actually parsed cleanly — the silent-miss failure mode the doctrine
 * "Per-finding confidence must reflect per-rule coverage limitations"
 * names at the per-finding layer.
 */
export function partitionParseStateFiles(
  files: readonly ParsedFile[],
  findingFilePaths: ReadonlySet<string> | undefined,
): { readonly parseError: ReadonlySet<string>; readonly partialParse: ReadonlySet<string> } {
  const parseError = new Set<string>();
  const partialParse = new Set<string>();
  for (const f of files) {
    if (f.ast.errors.length === 0) continue;
    if (isBuildArtifact(f.filePath, f.source)) continue;
    if (findingFilePaths?.has(f.filePath)) partialParse.add(f.filePath);
    else parseError.add(f.filePath);
  }
  return { parseError, partialParse };
}

/**
 * Per-row adjustment helper for {@link applyParseErrorAdjustment}.
 * Returns the input row unchanged when neither parse-error nor
 * partial-parse files matched the rule's gate; otherwise returns a
 * fresh row with `filesEvaluated` / `coverageConfidence` /
 * `coverageConfidenceReason` updated. The original row's optional
 * fields (`concentration`, `classPatternConcentration`, etc.) survive
 * via the spread so the adjustment never strips additive telemetry.
 */
function adjustRowForParseErrors(
  row: PerRuleCoverage,
  rule: Rule | undefined,
  parseErrorFiles: readonly ParsedFile[],
  partialParseFiles: readonly ParsedFile[],
): PerRuleCoverage {
  // Level-gated rows were never evaluated against any file (the
  // standard filter excluded the rule before per-file dispatch), so
  // stamping `coverageConfidenceReason: "partial-parse"` on a
  // gated row would lie about why its `filesEvaluated` is zero —
  // the cause is level gating, not parse error. Pass through
  // unchanged.
  if (row.skipReason === "gated_by_level") return row;
  const parseErrorMatches = countMatchingFiles(rule, parseErrorFiles);
  const partialParseMatches = countMatchingFiles(rule, partialParseFiles);
  if (parseErrorMatches === 0 && partialParseMatches === 0) return row;
  // Subtract parse-error matches from `filesEvaluated`. Floor at 0 so
  // an off-by-one in match counting never produces a negative count
  // on the wire — defensive for callers that pre-trim rows.
  const adjustedEvaluated = Math.max(0, row.filesEvaluated - parseErrorMatches);
  // Partial-parse files still contributed to evaluation (rules fired
  // on the recovered AST), so confidence drops without changing the
  // count. Parse-error matches alone also drop confidence: the rule
  // may have lost its only honest evidence horizon on this scan.
  const reason = parseErrorMatches > 0 ? "file-parse-error" : "partial-parse";
  return {
    ...row,
    filesEvaluated: adjustedEvaluated,
    coverageConfidence: "low",
    coverageConfidenceReason: reason,
  };
}

/**
 * returns the subset of
 * scanned `.scss` files that declare top-level `$variable: …`
 * statements but produced zero literal-color usages downstream after
 * the SCSS preprocessor's substitution pass — the canonical
 * "token-only theme partial" / `_variables.scss` shape that reads as
 * `findings: []` with `coverageConfidence: "high"` despite the
 * scanner having no contrast evidence to evaluate.
 *
 * Pure over its inputs; runs `scssVariableDeclarationsLikelyUnresolved`
 * on every parsed `.scss` file. The result drives both the
 * `coverageConfidenceReason: "scss-unresolved-variables"` per-rule
 * downgrade ({@link applyScssUnresolvedVariablesAdjustment}) and the
 * top-level `scss_unresolved_variables` warning code's
 * `warningsDetails.scss_unresolved_variables.files` payload — so the
 * agent reading either surface gets the same file list and decides
 * whether to scan the compiled CSS output for full coverage.
 *
 * Returns paths in sorted order so wire output is deterministic across
 * runs. Empty array (not `undefined`) when no files match — callers
 * conditional-spread on `length > 0`.
 */
export function detectScssUnresolvedVariableFiles(files: readonly ParsedFile[]): readonly string[] {
  const out: string[] = [];
  for (const file of files) {
    if (!file.filePath.toLowerCase().endsWith(".scss")) continue;
    if (file.ast.language !== "css") continue;
    if (scssVariableDeclarationsLikelyUnresolved(file.source, file.ast.root)) {
      out.push(file.filePath);
    }
  }
  out.sort();
  return out;
}

/**
 * returns the subset
 * of scanned HTML-family files whose parsed root is a fragment — no
 * `<html>` ancestor, no `<body>` descendant. Mirrors the predicate
 * {@link buildAnalysisCoverage} uses to populate
 * `meta.analysisCoverage.fragmentFiles[]` so the file list driving the
 * `coverageConfidenceReason: "fragment-input-no-document-envelope"`
 * per-rule downgrade and the file list the agent sees on the meta
 * surface stay identical — same evidence, same closure path.
 *
 * Returns paths in sorted order so wire output is deterministic across
 * runs. Empty array when no fragment files are present — callers
 * conditional-spread on `length > 0`.
 */
export function detectFragmentFiles(files: readonly ParsedFile[]): readonly string[] {
  const out: string[] = [];
  for (const file of files) {
    if (file.ast.language !== "html") continue;
    if (isHtmlFragment(file.ast.root as HtmlDocument)) out.push(file.filePath);
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
function countMatchingFiles(rule: Rule | undefined, pool: readonly ParsedFile[]): number {
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
 * {@link buildScanPlan}. Conditional-spread per CLAUDE.md §1
 * "Ambiguous field shapes are dishonest": when no build artifacts
 * were classified for the scan (the `vendorPaths` set is empty), the
 * split would always read `{ source: <total>, buildArtifact: 0 }` —
 * a field whose only signal is "no artifacts," which the existing
 * `meta.scannedBuildArtifacts` absence already conveys honestly.
 * Omitting in the no-artifacts case keeps the present-when-meaningful
 * shape and avoids two fields telling the same story.
 *
 * Identity-stable when the spread is a no-op (no artifacts), so
 * callers can route through this helper unconditionally without
 * paying for a shallow copy on the common case.
 *
 * Designed to run AFTER {@link buildScanPlan} produced the `plan`
 * record but BEFORE the `plan` reaches the wire — `tool-scan-project.ts`
 * calls this between the build-artifact classification pass and
 * `assembleScanProjectResponse`, which is the only seam where both
 * the per-file finding buckets and the vendor path set are in scope.
 */
export function withViolationsByScanKind(
  plan: Record<string, unknown>,
  files: readonly {
    readonly path: string;
    readonly findings: readonly { readonly severity: string }[];
  }[],
  vendorPaths: ReadonlySet<string>,
): Record<string, unknown> {
  if (vendorPaths.size === 0) return plan;
  const split = splitViolationsByScanKind(files, vendorPaths);
  return { ...plan, violationsByScanKind: split };
}

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
 */
export interface TopRule {
  readonly ruleId: string;
  readonly count: number;
  readonly topFile?: string;
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
    readonly findings: readonly { readonly ruleId: string; readonly severity: string }[];
  }[],
  limit: number = TOP_RULES_DEFAULT_LIMIT,
): readonly TopRule[] {
  const tally = tallyTopRules(files);
  const ranked: TopRule[] = [];
  for (const [ruleId, count] of tally.totals) {
    const fileCounts = tally.perFile.get(ruleId);
    const topFile = fileCounts === undefined ? undefined : pickDensestFile(fileCounts);
    ranked.push({ ruleId, count, ...(topFile === undefined ? {} : { topFile }) });
  }
  // Count desc; ruleId asc tiebreak so the wire shape stays stable
  // across runs even when the underlying scanner reorders discovery.
  ranked.sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId));
  return ranked.slice(0, limit);
}

/**
 * Single-pass walker for {@link computeTopRules}. Builds the
 * per-rule total count and the per-(rule, path) sub-tally that the
 * `topFile` annotation reads from, in one walk over the input. Pure
 * over its input; extracted so the orchestrator
 * {@link computeTopRules} stays inside the cognitive-complexity cap.
 *
 * Severity filter — info-severity findings are skipped here so both
 * the count axis and the densest-file selection stay aligned with
 * the error+warning surface `plan.fixesByClass` tallies.
 */
function tallyTopRules(
  files: readonly {
    readonly path: string;
    readonly findings: readonly { readonly ruleId: string; readonly severity: string }[];
  }[],
): {
  readonly totals: ReadonlyMap<string, number>;
  readonly perFile: ReadonlyMap<string, ReadonlyMap<string, number>>;
} {
  const totals = new Map<string, number>();
  const perFile = new Map<string, Map<string, number>>();
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
    }
  }
  return { totals, perFile };
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
    readonly findings: readonly { readonly ruleId: string; readonly severity: string }[];
  }[],
  limit: number = TOP_RULES_DEFAULT_LIMIT,
): Record<string, unknown> {
  const topRules = computeTopRules(files, limit);
  if (topRules.length === 0) return plan;
  return { ...plan, topRules };
}
