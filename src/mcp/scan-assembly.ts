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
  readonly safeEdits: number;
  readonly violationsWithoutAnyFix: number;
  readonly actionableManual: number;
  readonly untargetedCriteria: number;
  /**
   * Violation count per `fixClass` lane — powers the honest breakdown
   * in the plan-summary prose. Distinct axis from `safeEdits`, which
   * answers "payload-availability" (has `fixPaths.primary.edit`) across
   * the mechanical + verify-in-source lanes rather than routing by
   * rule-demanded remediation lane. Not interchangeable — see
   * src/mcp/plan-summary.ts for rationale.
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
   */
  readonly fixesByClass: FixesByClass;
}): Record<string, unknown> {
  const {
    violations,
    notes,
    safeEdits,
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
    violations,
    notes,
    ...(safeEdits > 0 ? { safeEditsAvailable: safeEdits } : {}),
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
  } = args;
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
    ...buildAnalysisCoverage(
      files,
      wrappers,
      activeRules,
      verboseMeta,
      wrapperProvenance.fromAutoDetect.confirmed.length,
      preset,
      discoveryDiagnostics,
    ),
    // Audit trail for every in-source `ra11y-disable` pragma — keeps
    // suppressions visible and accountable. Omitted when no pragmas
    // exist in any scanned file.
    ...suppressionsMetaBlock(suppressions),
    // Per-rule evaluation telemetry for extension-gated rules. Low-
    // confidence rows carry a `reason` + `remediation` so an agent can
    // act on the gap (canonical case: Tailwind pre-build where
    // `contrast/minimum` runs on 0 eligible CSS files and the headline
    // 0 findings is meaningless without this context). Omitted when
    // the array is empty.
    ...(perRuleCoverage.length > 0 ? { perRuleCoverage } : {}),
  };
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
