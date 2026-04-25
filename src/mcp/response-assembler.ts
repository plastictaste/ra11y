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
 *  10. Stamp the cross-surface tripwire via {@link buildCountsBySurface}
 *      so `meta.countsBySurface` lands on the wire whenever the three
 *      scan-family totals (`plan.violations+notes`,
 *      `sum(perRuleCoverage.findingsEmitted)`,
 *      `sum(files[*].findings)`) disagree
 *      (Q5-HEADLINE-COUNT-DRIFT-THREE-TOTALS).
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
import { hasMetaArrayTruncation } from "./meta-array-cap.ts";
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
import {
  applyParseErrorAdjustment,
  applyScssUnresolvedVariablesAdjustment,
  buildScanMeta,
  buildScanPlan,
  detectScssUnresolvedVariableFiles,
  sumFindingsAcrossFiles,
  sumFindingsEmitted,
  withCountsBySurface,
} from "./scan-assembly.ts";
import type { SuppressionAuditEntry } from "./suppression-audit.ts";
import { applyTokenBudget, DEFAULT_TOKEN_BUDGET_CHARS } from "./token-budget.ts";
import type { ScanWarningCode, ScanWarningDetails, WarningInputs } from "./warnings.ts";
import { computeTemplateDirectiveOverlap, warningsField } from "./warnings.ts";
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
  /**
   * Q-SHARED-NO-CONFIG-WARNING-TINY-REPO: caller-supplied result of
   * `sawProjectMarkerInWalk(root)`. Gates the `no_config_found`
   * warning so tiny-repo / demo-size scans (50projects50days
   * standalone files, bootstrap/jekyll sub-tree demos,
   * website-templates individual dirs) don't rebroadcast the
   * `meta.configSource: null` signal as a top-level warning that
   * fires on every such scan. Omit when the caller didn't probe; the
   * warning drops conservatively in that case.
   */
  readonly configSearchSawProjectMarker?: boolean;
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

/**
 * Set of file paths that produced at least one finding in `violations`.
 * Feeds the parse-error split in `analysisCoverage` — errored files
 * whose path appears here land in `partialParseFiles` (rules fired on
 * the recovered slice); the rest land in `parseErrorFiles`
 * (invisible-to-rules). Extracted so {@link assembleScanFamilyResponse}
 * stays under the cognitive-complexity cap.
 */
function findingFilePathSet(violations: readonly Violation[]): Set<string> {
  const out = new Set<string>();
  for (const v of violations) out.add(v.location.filePath);
  return out;
}

/**
 * Groups violations into AgentFile buckets keyed by path; sorted
 * deterministically by codepoint order.
 *
 * Exported so scan-adjacent handlers that emit bespoke outer shapes —
 * `baseline.check` returns `{ mode, isPassing, newViolationCount, files,
 * resolvedEntries, … }`, not the scan-family `{ plan, files, meta }`
 * envelope — can still share the per-file grouping seam. The full
 * {@link assembleScanFamilyResponse} entrypoint is wrong for those
 * handlers (ADR 0024 / V1-RESPONSE-FIX-FAMILY: forcing them through
 * the assembler would sum categorically different meta shapes), but
 * the `files` sub-tree is identical in kind: a sorted list of
 * `{ path, findings }` buckets where each finding is
 * `buildAgentFinding(v, { suppressPlacement: "omit" })`.
 */
export function groupByFile(violations: readonly Violation[]): AssembledFile[] {
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
 * Assemble the warnings channel for {@link assembleScanFamilyResponse}.
 * Extracted to keep the orchestrator under the cognitive-complexity cap
 * as new optional signal fields accrete (Q-SHARED-NO-CONFIG-WARNING-TINY-REPO
 * added `configSearchSawProjectMarker` on top of the earlier
 * `storybookPresetActive` / `sessionWrappersMismatchCwd` conditionals).
 *
 * Pure over its inputs. The Q4-WARNING-DOWNGRADE-NOISE overlap check
 * reads `findings` out of `violations` + source out of `parsedFiles`
 * because both are already on the orchestrator's stack.
 */
function buildAssemblerWarningsField(args: {
  readonly meta: Record<string, unknown>;
  readonly violations: readonly Violation[];
  readonly parsedFiles: readonly ParsedFile[];
  readonly rootSource: ScanFamilyResponseInput["rootSource"];
  readonly configSource: ScanFamilyResponseInput["configSource"];
  readonly scannedBuildArtifactsPresent: boolean | undefined;
  readonly storybookPresetActive: boolean | undefined;
  readonly sessionWrappersMismatchCwd: boolean | undefined;
  readonly configSearchSawProjectMarker: boolean | undefined;
  readonly scssUnresolvedVariableFiles?: readonly string[];
}): {
  readonly warnings?: readonly ScanWarningCode[];
  readonly warningsDetails?: ScanWarningDetails;
} {
  // `buildScanMeta` guarantees these are objects with the expected
  // shape — the Record<string, unknown> return forces a cast at the
  // consumption site. Safe because the producer is our own helper.
  const analysisCoverage = args.meta["analysisCoverage"] as Record<string, unknown> | undefined;
  const filesByExtension = args.meta["filesByExtension"] as Record<string, number> | undefined;
  const templateDirectivesOverlap = computeTemplateDirectiveOverlap({
    findings: args.violations.map((v) => ({
      filePath: v.location.filePath,
      line: v.location.line,
    })),
    sourcesByPath: new Map(args.parsedFiles.map((f) => [f.filePath, f.source])),
  });
  // Q-SHARED-META-ARRAY-BUDGET-CAP: the assembler-seam meta block
  // already carries the capped `analysisCoverage.*` arrays with
  // their per-array `*Truncated: { shown, total }` siblings; derive
  // the top-level `response_meta_truncated` code by scanning meta
  // for any truncation summary. `scannedBuildArtifacts` is NOT
  // assembled through this seam (`scan_project` handles it) so
  // only the coverage block's flags surface here — safe because
  // `hasMetaArrayTruncation` handles both containers uniformly.
  const metaArrayTruncated = hasMetaArrayTruncation(args.meta);
  return warningsField({
    filesScanned: args.parsedFiles.length,
    rootSource: args.rootSource,
    configSource: args.configSource,
    analysisCoverage,
    filesByExtension,
    ...(args.scannedBuildArtifactsPresent === undefined
      ? {}
      : { scannedBuildArtifactsPresent: args.scannedBuildArtifactsPresent }),
    ...(args.storybookPresetActive === undefined
      ? {}
      : { storybookPresetActive: args.storybookPresetActive }),
    ...(args.sessionWrappersMismatchCwd === undefined
      ? {}
      : { sessionWrappersMismatchCwd: args.sessionWrappersMismatchCwd }),
    templateDirectivesOverlap,
    ...(args.configSearchSawProjectMarker === undefined
      ? {}
      : { configSearchSawProjectMarker: args.configSearchSawProjectMarker }),
    ...(metaArrayTruncated ? { metaArrayTruncated: true } : {}),
    ...(args.scssUnresolvedVariableFiles === undefined ||
    args.scssUnresolvedVariableFiles.length === 0
      ? {}
      : { scssUnresolvedVariableFiles: args.scssUnresolvedVariableFiles }),
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
    configSearchSawProjectMarker,
  } = input;

  // (1) Group + build per-file findings.
  let fileEntries: readonly AssembledFile[] = groupByFile(violations);

  // (2) Split notes from non-notes; tally fixes.
  const nonNote = violations.filter((v) => v.severity !== "info");
  const notes = violations.filter((v) => v.severity === "info");
  const { editsWithInlineFixPath, proseOnlySuggestions } = countFixes(nonNote);
  const violationsWithoutAnyFix = nonNote.length - editsWithInlineFixPath - proseOnlySuggestions;
  const fixesByClass = countFixesByClass(nonNote);
  const fixClassCounts = {
    mechanical: fixesByClass.mechanical,
    guidance: fixesByClass.guidance,
    "runtime-only": fixesByClass.runtimeOnly,
    "verify-in-source": fixesByClass.verifyInSource,
  };

  // (3) Plan — honest conditional-spread counters live inside buildScanPlan.
  // The former `safeEdits` arg was removed per
  // Q-SHARED-SAFE-EDITS-VS-MECHANICAL-DISAGREEMENT; the structured
  // `fixesByClass` carries the honest per-lane signal.
  const plan = buildScanPlan({
    violations: nonNote.length,
    notes: notes.length,
    violationsWithoutAnyFix,
    actionableManual,
    untargetedCriteria,
    fixClassCounts,
    fixesByClass,
  });

  // (4) Meta. `findingFilePaths` is derived from the ALL violations
  // input (pre-note-split) so a file that produced only info-severity
  // notes still counts as "rules fired on it" — the point of the
  // partial-parse bucket is to distinguish "rules ran" from "rules
  // couldn't see anything," not to filter by severity.
  const findingFilePaths = findingFilePathSet(violations);
  // V1-PERRULE-COVERAGE-HONESTY-ON-PARSE-ERRORS: route the rows
  // through the parse-error adjustment once so the meta block and the
  // top-level `ruleCoverage` derivative agree on which rules
  // confidently cleaned (parse-error files no longer count toward
  // `filesEvaluated`; partial-parse matches drop confidence to
  // `"low"`). No-op fast path when the scan has no parse errors.
  // V1-SCSS-CONTRAST-VARIABLES-ZERO-OUTPUT: chain a second adjustment
  // for `.scss` files where `$variable: …;` declarations produced no
  // literal-color usages — drops `coverageConfidence` to `"medium"`
  // with `coverageConfidenceReason: "scss-unresolved-variables"` so
  // a token-only theme partial doesn't read as `findings: []` /
  // `coverageConfidence: "high"`. Parse-error precedence is honored:
  // a row already at `"low"` keeps its existing reason.
  const scssUnresolvedFiles = detectScssUnresolvedVariableFiles(parsedFiles);
  const parseErrorAdjusted = applyParseErrorAdjustment(
    perRuleCoverage,
    parsedFiles,
    activeRules,
    findingFilePaths,
  );
  const adjustedPerRuleCoverage = applyScssUnresolvedVariablesAdjustment(
    parseErrorAdjusted,
    parsedFiles,
    activeRules,
    new Set(scssUnresolvedFiles),
  );
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
    perRuleCoverage: adjustedPerRuleCoverage,
    findingFilePaths,
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

  // (6) Rule-coverage derivative — only when non-null. Uses the
  // adjusted rows so the derivative's `confidentlyClean` /
  // `lowConfidenceClean` split matches what `meta.perRuleCoverage`
  // surfaces.
  const ruleCoverage = buildRuleCoverageDerivative(adjustedPerRuleCoverage, violations);

  // (7) Review candidates — opt-in dedupe at the single-file level.
  const includeReview = options.includeReviewCandidates === true;
  const dedupedCandidates = includeReview
    ? dedupeReviewCandidatesForSingleFile(reviewCandidates)
    : undefined;

  // (8) Warnings channel — extracted to keep this orchestrator's
  // cognitive complexity inside the lint cap as new signals accrete.
  const warnFields = buildAssemblerWarningsField({
    meta,
    violations,
    parsedFiles,
    rootSource,
    configSource,
    scannedBuildArtifactsPresent,
    storybookPresetActive,
    sessionWrappersMismatchCwd,
    configSearchSawProjectMarker,
    scssUnresolvedVariableFiles: scssUnresolvedFiles,
  });

  // Q5-HEADLINE-COUNT-DRIFT-THREE-TOTALS: three totals a scan-family
  // consumer can read off one response have diverged in field reports
  // (plan.violations+notes vs sum(perRuleCoverage.findingsEmitted) vs
  // sum(files[*].findings)). The filters between the scanner-raw stream
  // (`perRuleCoverage`) and the filtered stream (`plan` + `files`) —
  // wrapper-noise drop, severity, criterion-skip — eat findings the
  // per-rule rows still count, and trim steps (token-density below,
  // plus scan_project's caller-driven pagination) can further reduce
  // what actually ships in `files[]`. Emit `meta.countsBySurface` whenever
  // the three disagree so the drift is a visible tripwire instead of a
  // silent miss the agent has to discover by summation. Pre-trim
  // computation here ensures the `plan` and `perRuleCoverage` numbers
  // are always paired; the `filesSurface` figure is stamped below on the
  // final path so it reflects what actually rides on the wire.
  const planTotal = nonNote.length + notes.length;
  const perRuleCoverageTotal = sumFindingsEmitted(perRuleCoverage);

  // Base response — every optional field conditional-spread per
  // CLAUDE.md §1 "Ambiguous field shapes are dishonest."
  const baseResponse: ScanFamilyResponse = {
    plan,
    files: fileEntries,
    meta: withCountsBySurface(meta, {
      plan: planTotal,
      perRuleCoverage: perRuleCoverageTotal,
      filesSurface: sumFindingsAcrossFiles(fileEntries),
    }),
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

  // Truncation dropped trailing files — `filesSurface` now lags the
  // `plan` total by the dropped findings, so re-stamp the tripwire with
  // the post-trim count.
  const trimmedFiles = budgetResult.files as readonly AssembledFile[];
  return {
    ...baseResponse,
    files: trimmedFiles,
    meta: withCountsBySurface(meta, {
      plan: planTotal,
      perRuleCoverage: perRuleCoverageTotal,
      filesSurface: sumFindingsAcrossFiles(trimmedFiles),
    }),
    truncated: true,
    ...(budgetResult.nextOffset === undefined ? {} : { nextOffset: budgetResult.nextOffset }),
  };
}

/**
 * Thin wrapper over {@link warningsField} for the scan-derivative tools
 * (`checklist`, `coverage`, `conformance_statement`) — ADR 0024 stage 4.
 *
 * The derivative tools own bespoke outer shapes (checklist buckets,
 * coverage per-criterion rollups, conformance narrative) so they do NOT
 * flow through the full {@link assembleScanFamilyResponse} seam — there
 * is no `{plan, meta, files}` sub-tree to emit. What they DO need is the
 * same scan-confidence warnings predicate the primary scan tools use,
 * exposed under a name that documents the derivative-tool use case so a
 * future reader of the handler can tell at a glance that the tool is
 * participating in the assembler-seam warnings contract rather than
 * emitting its own bespoke warnings shape.
 *
 * Both return the spreadable fragment `{ warnings?, warningsDetails? }`
 * per CLAUDE.md §1 "present-when-meaningful" — fields only appear when
 * at least one code fires. Derivative handlers that already carry
 * domain-specific warnings (e.g. `non_git_repo_signature_omitted` on
 * `conformance_statement`) merge the structured codes returned here
 * with their bespoke list before emitting the final `warnings` array.
 */
export function buildDerivativeScanWarnings(inputs: WarningInputs): {
  readonly warnings?: readonly ScanWarningCode[];
  readonly warningsDetails?: ScanWarningDetails;
} {
  return warningsField(inputs);
}
