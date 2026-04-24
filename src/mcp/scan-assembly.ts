/**
 * Scan-response assemblers — the `plan` and `meta` block builders
 * consumed by `runScanAndFormat`. Extracted so tools-helpers.ts stays
 * under the 500-line budget and the honest-shape rules
 * (conditional-spread on zero counts, split mechanical vs guidance
 * fixes, separate actionable-vs-untargeted manual counters, per-scan
 * `limitations` prose) live next to the shape they describe.
 */

import type { ParsedFile } from "../engine/scanner.ts";
import type { DiscoveryDiagnostics } from "../input/discover.ts";
import type { FixesByClass } from "../output/agent-response/index.ts";
import type { ConfigPreset } from "../types/config.ts";
import type { Rule } from "../types/rule.ts";
import type { PerRuleCoverage } from "../types/violation.ts";
import { extensionMatches } from "../utils/path.ts";
import { buildAnalysisCoverage } from "./analysis-coverage.ts";
import { buildPlanSummary, type FixClassCounts } from "./plan-summary.ts";
import { buildRulesEvaluated } from "./rules-evaluated.ts";
import { suppressionsMetaBlock } from "./suppression-audit.ts";
import type { ResolvedWrapperSources } from "./wrappers-meta.ts";
import { wrappersMetaBlock } from "./wrappers-meta.ts";

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
   * Violation count per `fixClass` lane — powers the honest breakdown
   * in the plan-summary prose. Distinct axis from payload-availability
   * ("does the Violation ship an inline `fixPaths.primary.edit`?")
   * which is no longer surfaced separately — see the
   * Q-SHARED-SAFE-EDITS-VS-MECHANICAL-DISAGREEMENT drop rationale below.
   */
  readonly fixClassCounts: FixClassCounts;
  /**
   * Per-{@link FixClass} tally surfaced as the structured sibling
   * `plan.fixesByClass`. Replaces the former `guidanceFixesAvailable`
   * headline, which summed four categorically different lanes under
   * one label — see `src/output/agent-response/build-plan.ts` for the
   * rationale and CLAUDE.md §1 "Composite headline counts are
   * dishonest." Always present on the response (zero-count lanes
   * surface as `0` so consumers never have to disambiguate "absent"
   * from "zero").
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
    fixClassCounts,
    fixesByClass,
  } = args;
  // `fixesByClass` is meaningful only when the scan actually produced
  // violations to bucket — emitting an all-zeros tally on a clean scan
  // is noise that forces the agent to read a field whose only signal
  // is "no violations." Conditional-spread per CLAUDE.md §1 keeps the
  // present-when-meaningful shape honest.
  const emitFixesByClass = violations > 0;
  return {
    // `totalFindings` was removed — it summed severity-distinct lanes
    // (violations + info-severity notes) under a single composite
    // headline and inflated the work an agent budgeted against. Per
    // CLAUDE.md §1 "Composite headline counts are dishonest," the
    // honest shape keeps `violations` and `notes` as split siblings
    // and trusts consumers to add them when they truly want a total.
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
    violations,
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
    summary: buildPlanSummary({
      violations,
      notes,
      fixClassCounts,
      actionableManual,
      untargetedCriteria,
    }),
  };
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
   * AND the response-level `extensions_skipped_no_parser` warning
   * code fires, plus a dense summary payload lands under
   * `warningsDetails.extensions_skipped_no_parser` per ADR 0023
   * (`topExtension`, `topCount`, `totalSkipped`, top-N `extensions`)
   * so an agent branching on the bare-string `warnings[]` channel can
   * answer "how bad, and in what kind of code?" without cross-
   * referencing `meta`. Omitted = the caller didn't run discovery
   * (e.g. `scan_file` takes explicit paths) or no files were skipped
   * by the extension check.
   */
  readonly discoveryDiagnostics?: DiscoveryDiagnostics;
  /**
   * Set of file paths that produced at least one finding in this scan
   * (violation OR info-severity note). Threaded to
   * {@link buildAnalysisCoverage} so parse-error files can be split
   * into total-failure (`parseErrorFiles` — zero findings emitted) and
   * partial-parse (`partialParseFiles` — rules fired on the recovered
   * slice) buckets. Omitted = caller hasn't wired findings yet, in
   * which case every errored file routes into `parseErrorFiles`
   * (historical behavior — safe default, never silently demotes).
   */
  readonly findingFilePaths?: ReadonlySet<string>;
}): Record<string, unknown> {
  const {
    filesScanned,
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
    // Per-extension counts build confidence that the scan actually saw
    // the file types agents expect (e.g., "0 .css scanned" is a red
    // flag if the repo has CSS). Cheap to compute, sorted for
    // determinism.
    filesByExtension: countByExtension(files),
    // Honest-shape rules-evaluated telemetry. Before
    // Q4-RULES-EVALUATED-COMPOSITE this was a single number that read
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
    // Omitted when the array is empty.
    ...(perRuleCoverage.length > 0 ? { perRuleCoverage } : {}),
  };
}

/**
 * Adjusts {@link PerRuleCoverage} rows so files that failed to parse
 * are honest about whether the rule actually evaluated their content
 * (V1-PERRULE-COVERAGE-HONESTY-ON-PARSE-ERRORS).
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
  const erroredFiles = files.filter((f) => f.ast.errors.length > 0);
  if (erroredFiles.length === 0) return rows;
  const parseErrorFiles: ParsedFile[] = [];
  const partialParseFiles: ParsedFile[] = [];
  for (const f of erroredFiles) {
    if (findingFilePaths?.has(f.filePath)) partialParseFiles.push(f);
    else parseErrorFiles.push(f);
  }
  const ruleById = new Map<string, Rule>();
  for (const r of activeRules) ruleById.set(r.id, r);
  return rows.map((row) =>
    adjustRowForParseErrors(row, ruleById.get(row.ruleId), parseErrorFiles, partialParseFiles),
  );
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
 * Three totals `scan_project` consumers have reported reading from the
 * same response and found disagreeing on the same wire:
 *
 *   - `plan` — `plan.violations + plan.notes`, the post-filter total
 *     computed from the `filtered` violation stream (post wrapper-noise
 *     drop, post severity filter, post criterion-skip). This is what
 *     `buildScanPlan`'s two counters sum to.
 *   - `perRuleCoverage` — `sum(perRuleCoverage[*].findingsEmitted)`, the
 *     scanner-raw total computed by {@link buildPerRuleCoverage} over
 *     every violation the engine emitted. Runs BEFORE wrapper-noise
 *     drop / severity / criterion-skip, so a non-trivial delta vs the
 *     `plan` surface means one of those filters consumed findings.
 *   - `filesSurface` — `sum(response.files[*].findings.length)` of the
 *     per-file buckets that actually landed on the wire. Starts at the
 *     same `filtered`-derived grouping the plan counts, but the token-
 *     density budget / file-count pagination can trim trailing file
 *     entries before the response ships. Paginated tools accumulate
 *     files over multiple calls; the scan-assembler path trims
 *     in-place.
 *
 * {@link PerRuleCoverage.findingsEmitted} aside, there is no place on
 * the current shape where all three numbers are written for the agent
 * to cross-check. When they disagree, the agent either treats one as
 * the headline and silently misses the drift (CLAUDE.md §1 "Composite
 * headline counts are dishonest") or makes a third round-trip to
 * reconcile. Surfacing the triple under a single `meta.countsBySurface`
 * object whenever they disagree is the additive tripwire this helper
 * produces.
 *
 * Honest shape (CLAUDE.md §1 "Ambiguous field shapes are dishonest"):
 *
 *   - Returns an empty spread when all three counts agree — no field on
 *     the wire for the common case.
 *   - Returns `{ countsBySurface: { plan, perRuleCoverage, filesSurface } }`
 *     when any pair differs. All three numbers are included so the
 *     agent doesn't have to guess which one is the outlier.
 *   - `filesSurface` is omitted when the caller doesn't know it yet
 *     (e.g. meta is being built before pagination). Inside the present
 *     field, `filesSurface` is therefore a required-when-present number
 *     — never a sentinel zero.
 */
export function buildCountsBySurface(args: {
  readonly plan: number;
  readonly perRuleCoverage: number;
  readonly filesSurface?: number;
}): { countsBySurface?: CountsBySurface } {
  const { plan, perRuleCoverage, filesSurface } = args;
  const disagree =
    plan !== perRuleCoverage || (filesSurface !== undefined && filesSurface !== plan);
  if (!disagree) return {};
  const payload: CountsBySurface = {
    plan,
    perRuleCoverage,
    ...(filesSurface === undefined ? {} : { filesSurface }),
  };
  return { countsBySurface: payload };
}

/**
 * Shape of the {@link buildCountsBySurface} payload when present. Named
 * so tests and cross-tool callers can import the type instead of
 * re-stating the record shape.
 */
export interface CountsBySurface {
  readonly plan: number;
  readonly perRuleCoverage: number;
  readonly filesSurface?: number;
}

/**
 * Stamp {@link buildCountsBySurface}'s honest-shape output onto a meta
 * block. Spreads an empty record when the three counts agree so the
 * common case puts nothing on the wire; spreads
 * `{ countsBySurface: { … } }` when any pair differs. Exported so every
 * assembler seam that materializes its own response shape (the
 * {@link assembleScanFamilyResponse} path, plus the
 * `scan_project`/`scan_diff` paths that bypass it via
 * {@link runScanAndFormat}) stamps through the same helper and the
 * V1-META-COUNTS-BY-SURFACE-REGRESSION silent-miss never reopens.
 *
 * Caller passes a fresh `countsInput` each time because `filesSurface`
 * can drift between the pre-trim emit path (before pagination /
 * token-density truncation) and the post-trim emit path (after the
 * wire shape settles).
 */
export function withCountsBySurface(
  meta: Record<string, unknown>,
  countsInput: Parameters<typeof buildCountsBySurface>[0],
): Record<string, unknown> {
  return { ...meta, ...buildCountsBySurface(countsInput) };
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
