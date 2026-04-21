/**
 * Scan-family collector (V1-RESPONSE-SCAN-CORE).
 *
 * Runs the scanner plus the post-processing every scan-family tool
 * shares (severity filter, caller-driven criterion skip, wrapper-noise
 * drop, unused-wrapper resolution, suppression audit, manual-review
 * tally) and returns the raw inputs
 * {@link ../mcp/response-assembler.ts!assembleScanFamilyResponse}
 * consumes.
 *
 * Companion to `tools-helpers.ts`'s `runScanAndFormat`: same scan
 * work, different return shape. New handlers (scan, scan_file, and
 * future migrations) route through this helper so every scan-family
 * response lands in the assembler with identical pre-processing —
 * eliminating the open-coded `plan`/`meta` drift vector the old
 * `runScanAndFormat` + inline-assembly pattern carried. Extracted to
 * its own module so `tools-helpers.ts` stays under the 500-effective-
 * line file budget.
 */

import { type ParsedFile, runScan } from "../engine/scanner.ts";
import type { ConfigPreset, Process } from "../types/config.ts";
import type { ReviewCandidate } from "../types/review.ts";
import type { Rule } from "../types/rule.ts";
import type { PerRuleCoverage, Violation } from "../types/violation.ts";
import type { McpSession } from "./session.ts";
import { suppressionAudit, type SuppressionAuditEntry } from "./suppression-audit.ts";
import {
  applyCriterionSkip,
  applyRuleSettings,
  collectManualCriteria,
  dropWrapperNoise,
  filterBySeverity,
  loadDurableAttestations,
} from "./tools-helpers.ts";
import {
  buildRunScanOptions,
  type NativeWrapperSources,
  type ResolvedWrapperSources,
  resolveUnusedWrappers,
  resolveWrapperSources,
} from "./wrappers-meta.ts";

/**
 * Raw collected inputs from a scan run — the shape every scan-family
 * tool handler feeds into `assembleScanFamilyResponse`. Distinct from
 * `ScanFormatted`: this carries the UNPROCESSED source material
 * (violations array, active rules, wrapper sources, parsed files),
 * not the pre-assembled `plan`/`meta`/`files` sub-tree. The assembler
 * is the single seam that turns these facts into the response shape —
 * that is the V1-RESPONSE-SCAN-CORE invariant.
 */
export interface ScanCollected {
  readonly violations: readonly Violation[];
  readonly parsedFiles: readonly ParsedFile[];
  readonly activeRules: readonly Rule[];
  readonly durationMs: number;
  readonly filesScanned: number;
  readonly enabledStandards: readonly string[];
  readonly perRuleCoverage: readonly PerRuleCoverage[];
  readonly reviewCandidates: readonly ReviewCandidate[];
  readonly wrappers: ResolvedWrapperSources;
  readonly unusedWrappers: readonly string[];
  readonly suppressions: readonly SuppressionAuditEntry[];
  readonly actionableManual: number;
  readonly untargetedCriteria: number;
}

/**
 * Args mirror `runScanAndFormat` so migrating a handler through the
 * assembler is a near 1:1 swap. `verboseMeta` / `preset` /
 * `discoveryDiagnostics` live on the assembler side — they shape the
 * response, not the scan.
 */
export interface RunScanAndCollectArgs {
  readonly files: readonly ParsedFile[];
  readonly session: McpSession;
  readonly enabled: readonly string[];
  readonly minSeverity: string | undefined;
  readonly ruleSettings?: Readonly<Record<string, string>>;
  readonly wrapperSources?: NativeWrapperSources;
  readonly cwd?: string;
  readonly skipCriteria?: readonly string[];
  readonly processes?: readonly Process[];
  /**
   * Resolved `LoadedConfig.preset`. Passes through to runScan-level
   * options via `buildRunScanOptions` if needed — kept on the args
   * surface for uniformity with `runScanAndFormat`, but not currently
   * consumed by the scanner; assembler uses it for analysis-coverage
   * framing.
   */
  readonly preset?: ConfigPreset;
}

/**
 * Runs the scanner and collects the inputs the scan-family response
 * assembler needs. Pure over its inputs (no I/O beyond the scanner +
 * attestations read).
 */
export async function runScanAndCollect(args: RunScanAndCollectArgs): Promise<ScanCollected> {
  const {
    files,
    session,
    enabled,
    minSeverity,
    ruleSettings,
    wrapperSources,
    cwd,
    skipCriteria,
    processes,
  } = args;
  const effective = ruleSettings ?? session.config.rules;
  const activeRules = applyRuleSettings(session.registry.rules, effective);
  const attestations = await loadDurableAttestations(cwd ?? process.cwd());
  const resolvedWrappers = resolveWrapperSources(wrapperSources, session);
  const { result, report, perRuleCoverage } = runScan(
    buildRunScanOptions({
      activeRules,
      enabled,
      files,
      level: session.config.level,
      attestations,
      processes,
      wrapperElements: resolvedWrappers.elements,
      session,
    }),
  );
  const { violations: withoutWrapperNoise } = dropWrapperNoise(
    result.violations,
    resolvedWrappers.wrappers,
  );
  const unusedWrappers = await resolveUnusedWrappers(resolvedWrappers.wrappers, files, cwd);
  const severityFiltered = filterBySeverity(withoutWrapperNoise, minSeverity);
  const filtered = applyCriterionSkip(severityFiltered, skipCriteria);
  const suppressions = suppressionAudit(files);
  const rawCandidates = report.candidates ?? [];
  const manualIds = collectManualCriteria(enabled, session, session.config.level, files);
  // Plan-side split: grounded candidates (file:line) vs.
  // bare-criterion prompts. Same recipe runScanAndFormat uses — keeps
  // headline honest (CLAUDE.md §1 "Composite headline counts are
  // dishonest").
  const actionableManualIds = new Set<string>();
  for (const c of rawCandidates) {
    if (manualIds.has(c.criterionId)) actionableManualIds.add(c.criterionId);
  }
  const actionableManual = actionableManualIds.size;
  const untargetedCriteria = manualIds.size - actionableManual;

  return {
    violations: filtered,
    parsedFiles: files,
    activeRules,
    durationMs: result.durationMs,
    filesScanned: result.filesScanned,
    enabledStandards: result.enabledStandards,
    perRuleCoverage,
    reviewCandidates: rawCandidates,
    wrappers: resolvedWrappers,
    unusedWrappers,
    suppressions,
    actionableManual,
    untargetedCriteria,
  };
}
