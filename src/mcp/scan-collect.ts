/**
 * Scan-family collector.
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
import { stampFingerprintOccurrences } from "./file-fingerprint-stamp.ts";
import { detectApplicability } from "./manual-applicability.ts";
import { tallyManualCriteria } from "./manual-criteria-tally.ts";
import type { McpSession } from "./session.ts";
import { type SuppressionAuditEntry, suppressionAudit } from "./suppression-audit.ts";
import {
  applyCriterionSkip,
  applyRuleSettings,
  dropWrapperNoise,
  filterBySeverity,
  loadDurableAttestations,
} from "./tools-helpers.ts";
import { coupleSeverityToVerifyTokens } from "./violation-severity-coupling.ts";
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
 * that is the invariant.
 */
export interface ScanCollected {
  readonly violations: readonly Violation[];
  /**
   * Raw scanner-emitted violations BEFORE wrapper-noise / severity /
   * criterion-skip / vendor-CSS-dedupe filtering. The post-filter
   * `violations` field above is what the consumer reads on
   * `files[]`/`plan`; the raw stream is what scan-confidence telemetry
   * (the `parseErrorFiles` vs `partialParseFiles` split inside
   * `buildAnalysisCoverage`) must derive from so the count agrees
   * with `coverage` and `checklist` on identical input — those tools
   * apply no filters and always classify against the raw scanner
   * output. Cross-surface count invariant doctrine in
   * `docs/kb/architecture/ai-first-consumer.md`.
   */
  readonly rawViolations: readonly Violation[];
  readonly parsedFiles: readonly ParsedFile[];
  readonly activeRules: readonly Rule[];
  readonly durationMs: number;
  readonly filesScanned: number;
  readonly enabledStandards: readonly string[];
  readonly perRuleCoverage: readonly PerRuleCoverage[];
  /**
   * Threaded from {@link import("../engine/scanner.ts").ScanProducts.filesWithAnyRuleEvaluated}
   * so `assembleScanFamilyResponse` can split `meta.filesScanned` into
   * the file-reach pair (`filesWithAnyRuleEvaluated` +
   * `filesWithZeroRuleEvaluation`). See the field on {@link import("../engine/scanner.ts").ScanProducts}.
   */
  readonly filesWithAnyRuleEvaluated: number;
  readonly reviewCandidates: readonly ReviewCandidate[];
  readonly wrappers: ResolvedWrapperSources;
  readonly unusedWrappers: readonly string[];
  readonly suppressions: readonly SuppressionAuditEntry[];
  readonly actionableManual: number;
  /**
   * Per-criterion file-path index for the actionable manual-review
   * set. Threaded into the assembler so the downstream rewrite seam
   * (`withActionableManualItemsBySource` in `scan-assembly.ts`) can
   * intersect each criterion's contributing path set against the
   * resolved `vendorPaths` and produce the
   * `plan.actionableManualItemsBySource: { source, buildArtifact }`
   * lane split. See {@link ManualCriteriaTally#actionableCriteriaPaths}
   * for the doctrine pointer — the pre-split bare
   * `actionableManualItems` field violated the
   * "Composite headline counts are dishonest" rule on bulk-vendor
   * scans where every contributing candidate sat on the
   * `buildArtifact` lane.
   */
  readonly actionableCriteriaPaths: ReadonlyMap<string, ReadonlySet<string>>;
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
  /**
   * Cross-file byte-fingerprint duplicate map produced by the
   * pre-parse fingerprint pass in `src/input/file-fingerprint.ts`.
   * Threaded through the scan pipeline so the post-scan stamp
   * (`stampFingerprintOccurrences`) can attach `vendorOccurrences` to
   * findings emitted from canonical paths — every duplicate path
   * surfaces on the canonical finding without re-emitting per copy.
   *
   * Optional: omitted by callers that did not run the fingerprint
   * pre-pass (`scan_file` with explicit paths, `scan_diff` operating
   * on git-changed files). When undefined or empty, the stamping
   * helper short-circuits and the violation stream passes through
   * unchanged. Surface, don't suppress per AI-first doctrine — the
   * dedupe is lossless.
   */
  readonly fingerprintDuplicates?: ReadonlyMap<string, readonly string[]>;
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
    fingerprintDuplicates,
  } = args;
  const effective = ruleSettings ?? session.config.rules;
  const activeRules = applyRuleSettings(session.registry.rules, effective);
  const attestations = await loadDurableAttestations(cwd ?? process.cwd());
  const resolvedWrappers = resolveWrapperSources(wrapperSources, session);
  const {
    result: rawResult,
    report,
    perRuleCoverage,
    filesWithAnyRuleEvaluated,
  } = runScan(
    buildRunScanOptions({
      activeRules,
      enabled,
      files,
      level: session.config.level,
      attestations,
      processes,
      wrapperElements: resolvedWrappers.elements,
      session,
      // Per-emission `findingId` cross-surface invariant — when the
      // caller supplied a scan root, plumb through to the engine's
      // stamp sites so scan_file (relative input) and scan_project /
      // checklist (absolute discovery walk) hash the same id on the
      // same conceptual rule emission.
      ...(cwd === undefined ? {} : { scanRoot: cwd }),
    }),
  );
  // Couple severity to the curated verify-in-source token set on the
  // raw violation stream, BEFORE the AgentFinding pipeline and the
  // manual-review tally branch off `result.violations`. Doctrine source:
  // `docs/kb/architecture/ai-first-consumer.md` "Reason text and
  // severity must agree" (conceded-uncertainty extension) plus "Cross-
  // surface count invariant" — applying the coupling here ensures the
  // AgentFinding shape on the wire and the tally walking
  // `result.violations` see the same severity, so
  // `actionableManualItemsBySource` agrees with the per-finding
  // surfacing pressure the agent reads. See
  // `src/mcp/violation-severity-coupling.ts` for the closure rationale
  // (centralized normalization across the five rules with the same
  // dishonest shape).
  const result = {
    ...rawResult,
    violations: coupleSeverityToVerifyTokens(rawResult.violations),
  };
  const { violations: withoutWrapperNoise } = dropWrapperNoise(
    result.violations,
    resolvedWrappers.wrappers,
  );
  const unusedWrappers = await resolveUnusedWrappers(resolvedWrappers.wrappers, files, cwd);
  const severityFiltered = filterBySeverity(withoutWrapperNoise, minSeverity);
  // Pre-parse fingerprint pass dropped byte-identical
  // duplicates from the parse loop — stamp `vendorOccurrences` on
  // findings emitted from canonical paths so every duplicate path
  // stays enumerable on the wire. No-op when the caller did not
  // thread the fingerprint map (scan / scan_file with explicit
  // paths). See `src/mcp/file-fingerprint-stamp.ts` for the doctrine
  // pointer.
  const fingerprintStamped = stampFingerprintOccurrences(
    severityFiltered,
    fingerprintDuplicates ?? new Map(),
  );
  const filtered = applyCriterionSkip(fingerprintStamped, skipCriteria);
  const suppressions = suppressionAudit(files);
  const rawCandidates = report.candidates ?? [];
  // Plan-side split: grounded candidates (file:line) vs.
  // bare-criterion prompts. Routes through `tallyManualCriteria` so
  // the count agrees with `coverage[].untargetedCriteriaForProject`
  // and `checklist.summary.untargetedCriteriaForProject` on the same
  // input — see `docs/kb/architecture/ai-first-consumer.md` §"Cross-
  // surface count invariant" and `tests/integration/mcp-counts-agree.test.ts`.
  // (The per-file slice ships under `untargetedCriteriaForFile` from
  // `scan` / `scan_file` instead — same tally helper, different
  // wire-name to keep the two slices distinguishable on the agent
  // side.) The
  // pre-helper recipe used `collectManualCriteria` which kept fired
  // metadata-manual criteria in the manual queue; coverage and checklist
  // route them into the failing lane, and the off-by-N drift was
  // exactly that asymmetry.
  const tally = tallyManualCriteria({
    standards: session.registry.standards,
    enabledStandards: enabled,
    level: session.config.level,
    scanResult: result,
    applicability: detectApplicability(files),
    candidates: rawCandidates,
    // Q15-LANDMARK-MAIN: thread the raw violation stream so the
    // helper unions low-confidence verify-token findings' criteria
    // into the actionable count. Per
    // `docs/kb/architecture/ai-first-consumer.md` "Cross-surface
    // count invariant" — every project-rooted surface tallies off
    // the same raw set the parser-error and per-rule coverage
    // splits derive from. The wrapper-noise / severity /
    // criterion-skip filters that produce `filtered` below are
    // consumer-facing display shapes; the headline tally inputs
    // upstream of those filters.
    violations: result.violations,
  });
  const actionableManual = tally.actionable;
  const untargetedCriteria = tally.untargeted;

  return {
    violations: filtered,
    rawViolations: result.violations,
    parsedFiles: files,
    activeRules,
    durationMs: result.durationMs,
    filesScanned: result.filesScanned,
    enabledStandards: result.enabledStandards,
    perRuleCoverage,
    filesWithAnyRuleEvaluated,
    reviewCandidates: rawCandidates,
    wrappers: resolvedWrappers,
    unusedWrappers,
    suppressions,
    actionableManual,
    actionableCriteriaPaths: tally.actionableCriteriaPaths,
    untargetedCriteria,
  };
}
