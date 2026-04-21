/**
 * Scan-family response assembler (V1-RESPONSE-ASSEMBLER / ADR 0024).
 *
 * One seam that every scan-family tool handler (`scan`, `scan_file`,
 * `scan_project`, `scan_diff`) will flow through once the doctrine-
 * load-bearing response shape lives here instead of being open-coded at
 * four near-identical call sites. This module is the additive first
 * stage — `tools-helpers.ts`, `tool-scan.ts`, etc. are not edited in
 * this commit; later stages migrate the callers.
 *
 * Orchestrates the existing helpers in declaration order — see ADR 0024
 * for the step-by-step rationale:
 *
 *   1. Group {@link Violation}s into per-file {@link AgentFinding}
 *      buckets sorted by path.
 *   2. Count mechanical edits + prose-only suggestions via
 *      {@link countFixes} / {@link countFixesByClass} so the plan
 *      headline splits by remediation lane (CLAUDE.md §1 "Composite
 *      headline counts are dishonest").
 *   3. Build `plan` via {@link buildScanPlan} with the honest
 *      conditional-spread counters.
 *   4. Build `meta` via {@link buildScanMeta}.
 *   5. Optionally hoist the suppressPlacement and duplicated
 *      `fix.description` prose via {@link hoistAndBuildReferenceGuide}
 *      — agents read each variant once, not once per finding.
 *   6. Derive `ruleCoverage` via {@link buildRuleCoverageDerivative};
 *      include only when non-null.
 *   7. Optionally dedupe review candidates across cross-standard
 *      criterion replication via
 *      {@link dedupeReviewCandidatesForSingleFile}.
 *   8. Assemble the warnings channel via {@link warningsField} so the
 *      zero-output-success ambiguity is closed with structured codes.
 *   9. Apply the token-density budget via {@link applyTokenBudget}
 *      when enabled — secondary guard that fires only when per-file
 *      density pushes past the MCP host ceiling.
 *
 * This module is pure — no I/O, no global state. The caller owns
 * loading the config, running the scanner, and threading the resulting
 * inputs through. Each optional block is conditional-spread at
 * assembly time per CLAUDE.md §1 "Ambiguous field shapes are dishonest":
 * the response carries a field only when the field has meaningful
 * content to report.
 */

import type { ParsedFile } from "../engine/scanner.ts";
import type { DiscoveryDiagnostics } from "../input/discover.ts";
import {
  type AgentFile,
  type AgentFinding,
  buildAgentFinding,
  countFixes,
  countFixesByClass,
} from "../output/agent-response/index.ts";
import type { ConfigPreset } from "../types/config.ts";
import type { ReviewCandidate } from "../types/review.ts";
import type { Rule } from "../types/rule.ts";
import type { PerRuleCoverage, Violation } from "../types/violation.ts";
import {
  buildReferenceGuide,
  hoistAndBuildReferenceGuide,
  type ReferenceGuide,
} from "./reference-guide.ts";
import {
  type DedupedReviewCandidate,
  dedupeReviewCandidatesForSingleFile,
} from "./review-candidate-dedup.ts";
import {
  buildRuleCoverageDerivative,
  type RuleCoverageDerivative,
} from "./rule-coverage-derivative.ts";
import { buildScanMeta, buildScanPlan } from "./scan-assembly.ts";
import type { SuppressionAuditEntry } from "./suppression-audit.ts";
import { applyTokenBudget, DEFAULT_TOKEN_BUDGET_CHARS } from "./token-budget.ts";
import type { ScanWarningCode, ScanWarningDetails } from "./warnings.ts";
import { warningsField } from "./warnings.ts";
import type { ResolvedWrapperSources } from "./wrappers-meta.ts";

/**
 * All inputs the assembler needs to build a scan-family response. Callers
 * have already run the scanner, filtered by severity/criterion, and
 * resolved wrapper/suppression metadata — the assembler is a pure
 * shape-builder over those facts.
 */
export interface ScanFamilyResponseInput {
  readonly violations: readonly Violation[];
  readonly parsedFiles: readonly ParsedFile[];
  readonly activeRules: readonly Rule[];
  readonly durationMs: number;
  readonly enabledStandards: readonly string[];
  readonly perRuleCoverage: readonly PerRuleCoverage[];
  readonly reviewCandidates: readonly ReviewCandidate[];
  readonly wrappers: ResolvedWrapperSources;
  readonly unusedWrappers: readonly string[];
  readonly suppressions: readonly SuppressionAuditEntry[];
  readonly verboseMeta: boolean;
  readonly preset: ConfigPreset | undefined;
  readonly discoveryDiagnostics?: DiscoveryDiagnostics;
  /** Plan-side manual-review counters — the caller computed them against `reviewCandidates`. */
  readonly actionableManual: number;
  readonly untargetedCriteria: number;
  /** Config-resolution signal for the warnings channel. */
  readonly configSource: string | null | undefined;
  readonly rootSource: "explicit" | "host-root" | "git" | "spawn-cwd" | null;
  readonly scannedBuildArtifactsPresent?: boolean;
  readonly storybookPresetActive?: boolean;
  readonly sessionWrappersMismatchCwd?: boolean;
}

export interface ScanFamilyResponseOptions {
  /** Default `true`. When `false`, omits the top-level `referenceGuide` even with findings. */
  readonly hoistReferenceGuide?: boolean;
  /** Default `true`. When `false`, omits the top-level `reviewCandidates` array. */
  readonly includeReviewCandidates?: boolean;
  /**
   * Token-density budget in characters. Defaults to
   * {@link DEFAULT_TOKEN_BUDGET_CHARS}. Pass `0` to disable truncation
   * entirely (e.g. for tests and non-MCP consumers that do not feed
   * into the host's token ceiling).
   */
  readonly tokenBudget?: number;
}

/** Agent-facing file bucket — path + sorted findings. */
export interface AssembledFile extends AgentFile {
  readonly path: string;
  readonly findings: readonly AgentFinding[];
}

/** Final assembled response shape. */
export interface ScanFamilyResponse {
  readonly plan: Record<string, unknown>;
  readonly files: readonly AssembledFile[];
  readonly meta: Record<string, unknown>;
  readonly warnings?: readonly ScanWarningCode[];
  readonly warningsDetails?: ScanWarningDetails;
  readonly referenceGuide?: ReferenceGuide;
  readonly reviewCandidates?: readonly DedupedReviewCandidate[];
  readonly ruleCoverage?: RuleCoverageDerivative;
  readonly truncated?: boolean;
  readonly nextOffset?: number;
}

/** Groups violations into AgentFile buckets keyed by path; sorted deterministically. */
function groupByFile(violations: readonly Violation[]): AssembledFile[] {
  const byPath = new Map<string, Violation[]>();
  for (const v of violations) {
    const bucket = byPath.get(v.location.filePath);
    if (bucket === undefined) byPath.set(v.location.filePath, [v]);
    else bucket.push(v);
  }
  const paths = [...byPath.keys()].sort();
  return paths.map((path) => {
    const bucketViolations = byPath.get(path) ?? [];
    const findings = bucketViolations.map((v) =>
      buildAgentFinding(v, { suppressPlacement: "omit" }),
    );
    return { path, findings };
  });
}

/**
 * Assemble the final scan-family response. Pure function over its
 * inputs — see the module docblock for the orchestration contract.
 */
export function assembleScanFamilyResponse(
  input: ScanFamilyResponseInput,
  options: ScanFamilyResponseOptions = {},
): ScanFamilyResponse {
  const {
    violations,
    parsedFiles,
    activeRules,
    durationMs,
    enabledStandards,
    perRuleCoverage,
    reviewCandidates,
    wrappers,
    unusedWrappers,
    suppressions,
    verboseMeta,
    preset,
    discoveryDiagnostics,
    actionableManual,
    untargetedCriteria,
    configSource,
    rootSource,
    scannedBuildArtifactsPresent,
    storybookPresetActive,
    sessionWrappersMismatchCwd,
  } = input;

  // (1) Group + build per-file findings.
  let fileEntries: readonly AssembledFile[] = groupByFile(violations);

  // (2) Split notes from non-notes; tally fixes.
  const nonNote = violations.filter((v) => v.severity !== "info");
  const notes = violations.filter((v) => v.severity === "info");
  const { mechanicalEditsAvailable: mechanicalEdits, proseOnlySuggestions } = countFixes(nonNote);
  const violationsWithoutAnyFix = nonNote.length - mechanicalEdits - proseOnlySuggestions;
  const fixesByClass = countFixesByClass(nonNote);
  const fixClassCounts = {
    mechanical: fixesByClass.mechanical,
    guidance: fixesByClass.guidance,
    "runtime-only": fixesByClass.runtimeOnly,
    "verify-in-source": fixesByClass.verifyInSource,
  };

  // (3) Plan — honest conditional-spread counters live inside buildScanPlan.
  const plan = buildScanPlan({
    totalFindings: violations.length,
    violations: nonNote.length,
    notes: notes.length,
    mechanicalEdits,
    violationsWithoutAnyFix,
    actionableManual,
    untargetedCriteria,
    fixClassCounts,
    fixesByClass,
  });

  // (4) Meta.
  const meta = buildScanMeta({
    filesScanned: parsedFiles.length,
    files: parsedFiles,
    activeRules,
    durationMs,
    enabledStandards,
    wrappers: wrappers.wrappers,
    sessionOnly: wrappers.sessionOnly,
    unusedWrappers,
    wrapperProvenance: wrappers.bySource,
    wrapperElements: wrappers.elements,
    verboseMeta,
    preset,
    suppressions,
    perRuleCoverage,
    ...(discoveryDiagnostics !== undefined &&
    Object.keys(discoveryDiagnostics.skippedByExtension).length > 0
      ? { discoveryDiagnostics }
      : {}),
  });

  // (5) Reference-guide hoist. Default on; explicit opt-out via option.
  let referenceGuide: ReferenceGuide | undefined;
  if (options.hoistReferenceGuide !== false) {
    const sourceGuide = buildReferenceGuide(fileEntries);
    const hoisted = hoistAndBuildReferenceGuide(fileEntries, sourceGuide);
    fileEntries = hoisted.files;
    referenceGuide = hoisted.referenceGuide;
  }

  // (6) Rule-coverage derivative — only when non-null.
  const ruleCoverage = buildRuleCoverageDerivative(perRuleCoverage, violations);

  // (7) Review candidates — opt-in dedupe at the single-file level.
  const includeReview = options.includeReviewCandidates === true;
  const dedupedCandidates = includeReview
    ? dedupeReviewCandidatesForSingleFile(reviewCandidates)
    : undefined;

  // (8) Warnings channel.
  // `buildScanMeta` guarantees these are objects with the expected
  // shape — the Record<string, unknown> return forces a cast at the
  // consumption site. Safe because the producer is our own helper.
  const analysisCoverage = meta["analysisCoverage"] as Record<string, unknown> | undefined;
  const filesByExtension = meta["filesByExtension"] as Record<string, number> | undefined;
  const warnFields = warningsField({
    filesScanned: parsedFiles.length,
    rootSource,
    configSource,
    analysisCoverage,
    filesByExtension,
    ...(scannedBuildArtifactsPresent === undefined ? {} : { scannedBuildArtifactsPresent }),
    ...(storybookPresetActive === undefined ? {} : { storybookPresetActive }),
    ...(sessionWrappersMismatchCwd === undefined ? {} : { sessionWrappersMismatchCwd }),
  });

  // Base response — every optional field conditional-spread per
  // CLAUDE.md §1 "Ambiguous field shapes are dishonest."
  const baseResponse: ScanFamilyResponse = {
    plan,
    files: fileEntries,
    meta,
    ...warnFields,
    ...(referenceGuide === undefined ? {} : { referenceGuide }),
    ...(dedupedCandidates !== undefined && dedupedCandidates.length > 0
      ? { reviewCandidates: dedupedCandidates }
      : {}),
    ...(ruleCoverage === null ? {} : { ruleCoverage }),
  };

  // (9) Token-density budget. Zero disables; undefined uses default.
  const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET_CHARS;
  if (tokenBudget === 0) return baseResponse;

  const budgetResult = applyTokenBudget({
    response: baseResponse as unknown as Record<string, unknown>,
    filesKey: "files",
    files: fileEntries,
    offset: 0,
    budgetChars: tokenBudget,
  });
  if (!budgetResult.truncated) return baseResponse;

  return {
    ...baseResponse,
    files: budgetResult.files as readonly AssembledFile[],
    truncated: true,
    ...(budgetResult.nextOffset === undefined ? {} : { nextOffset: budgetResult.nextOffset }),
  };
}
