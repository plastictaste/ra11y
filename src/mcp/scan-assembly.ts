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
  readonly totalFindings: number;
  readonly violations: number;
  readonly notes: number;
  readonly mechanicalEdits: number;
  readonly violationsWithoutAnyFix: number;
  readonly actionableManual: number;
  readonly untargetedCriteria: number;
  /**
   * Violation count per `fixClass` lane — powers the honest breakdown
   * in the plan-summary prose. Distinct axis from `mechanicalEdits`,
   * which answers "payload-availability" (has `fixPaths.primary.edit`)
   * rather than remediation lane. Not interchangeable — see
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
    totalFindings,
    violations,
    notes,
    mechanicalEdits,
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
    totalFindings,
    violations,
    notes,
    ...(mechanicalEdits > 0 ? { mechanicalEditsAvailable: mechanicalEdits } : {}),
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
   * non-empty, it surfaces in `analysisCoverage.skippedByExtension` and
   * the response-level `extensions_skipped_no_parser` warning code
   * fires. Omitted = the caller didn't run discovery (e.g. scan_file
   * takes explicit paths) or no files were skipped by the extension
   * check.
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
    // Count of rules that actually evaluated this scan — the same set
    // that drives `perRuleCoverage` so an agent can cross-reference
    // the two without worrying about drift. Before
    // V1-META-RULES-EVALUATED-COVERAGE-DRIFT this counted the
    // post-"off" rule list directly, which silently included rules
    // the standard filter dropped (never evaluated) and excluded
    // project-scoped rules from `perRuleCoverage` — agents couldn't
    // tell "ran-with-zero-eligible-files" from "never-ran." The
    // invariant `rulesEvaluated === perRuleCoverage.length` now holds
    // by construction: every evaluated rule gets a row; `filesEvaluated:
    // 0` + `coverageConfidence: "low"` names the zero-eligible case
    // honestly rather than going silently absent.
    rulesEvaluated: perRuleCoverage.length,
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
