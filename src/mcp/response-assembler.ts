/**
 * Scan-family response assembler (/ ADR 0024).
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
 * Note: the former step 10 (`meta.countsBySurface` cross-surface
 * tripwire) was dropped per "Composite headline counts are dishonest"
 * — a 4-way internal spread of disagreeing finding totals framed as
 * cross-surface reconciliation but read like an additional contested
 * headline. Consumers that want the totals read the structured
 * siblings (`plan.fixesByClass`, `meta.perRuleCoverage`, the per-file
 * `findings.length` rollup) directly.
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
import { collectBuildArtifacts } from "./build-artifacts.ts";
import { getTruncatedMetaArrayFields } from "./meta-array-cap.ts";
import { enrichFindingsWithBuildArtifactPath } from "./per-finding-build-artifact-confidence.ts";
import {
  buildPerRuleLimitationMap,
  enrichFindingsWithPerRuleLimitations,
} from "./per-finding-confidence-parity.ts";
import { buildSharedPerRuleCoverageMeta } from "./per-rule-coverage-shared.ts";
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
  buildScanMeta,
  buildScanPlan,
  detectLinkedStylesheetsNotResolvedForContrast,
  detectScssUnresolvedVariableFiles,
  isPerRuleCoverageUniformlyHigh,
  outputFilePathSet,
  partitionParseStateFiles,
} from "./scan-assembly.ts";
import { combineTemplateLiteralFiles } from "./scan-time-warnings.ts";
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
  /**
   * Raw scanner-emitted violations BEFORE caller-side filters
   * (severity / criterion-skip / wrapper-noise / vendor-CSS dedupe).
   * Drives the `parseErrorFiles` vs `partialParseFiles` split so
   * `analysisCoverage.parseErrorFileCount` reports the same number on
   * every project-rooted tool consuming the same scan input — the
   * cross-surface count invariant doctrine in
   * `docs/kb/architecture/ai-first-consumer.md` makes this load-bearing.
   * Without this, the post-filter `violations` field above silently
   * shrinks the parseError split on the scan-family path while
   * `coverage` / `checklist` (which apply no filters) keep the raw
   * view, drifting the count between tools on the same `cwd`.
   * Omit to fall back to `violations` (legacy callers).
   */
  readonly rawViolations?: readonly Violation[];
  readonly parsedFiles: readonly ParsedFile[];
  readonly activeRules: readonly Rule[];
  readonly durationMs: number;
  readonly enabledStandards: readonly string[];
  readonly perRuleCoverage: readonly PerRuleCoverage[];
  /**
   * Threaded from {@link import("../engine/scanner.ts").ScanProducts.filesWithAnyRuleEvaluated}.
   * Surfaces alongside `meta.filesScanned` so an agent reads the file-
   * reach split (corpus size vs. how many of those files at least one
   * per-file rule evaluated) in one pass. Omit on legacy / fixture
   * call sites that don't have access to the scanner output.
   */
  readonly filesWithAnyRuleEvaluated?: number;
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
  /**
   * Absolute path the config loader walked from. Drives the
   * `warningsDetails.no_config_found.searchedFrom` payload so every
   * project-rooted tool surfaces the same canonical "where did the
   * loader walk from" answer. Pass the same `cwd`/`root` the loader
   * was handed; omit when the tool did not resolve a search root.
   */
  readonly configSearchedFromForWarning?: string;
  /**
   * Pre-computed result of a cwd-rooted directory walk that probes
   * whether a rule's gated extensions exist anywhere under the project
   * root. Drives the {@link applyExtensionPresentSubkindAdjustment}
   * pass that stamps a `subkind: "extension-absent" |
   * "extension-present-but-out-of-scope"` discriminator on
   * `eligible === 0` extension-gated `perRuleCoverage` rows. The
   * caller computes the set via
   * {@link probeExtensionsAtRoot} and passes it through; the
   * assembler stays sync. Omit on single-file / explicit-paths
   * surfaces (`scan_file` has no cwd-rooted scope to reason about);
   * rows then ship without the `subkind` discriminator (honest
   * present-when-meaningful shape).
   */
  readonly extensionsPresentAtRoot?: ReadonlySet<string>;
  /**
   * `criterionId → level` lookup map drawn from the loaded standards
   * registry. Threaded through to
   * {@link import("./review-candidate-dedup.ts").dedupeReviewCandidatesForSingleFile}
   * so the per-candidate `priority` resolver can read each criterion's
   * level (A / AA / AAA / base) without coupling the dedup module to
   * the standards registry. Per
   * `docs/kb/architecture/ai-first-consumer.md` "Per-tool review-
   * candidate shape must agree across surfaces" — populating
   * `priority` on the scan_file `reviewCandidates[]` shape requires
   * the level lookup, and the shared resolver stays pure by taking
   * the map as input. Omit on legacy callers that don't surface
   * review candidates; falls back to an empty map and the resolver's
   * no-level base.
   */
  readonly criterionLevels?: ReadonlyMap<string, string>;
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
 * Set of file paths that produced at least one violation in `violations`
 * (rules-only — review candidates go through {@link outputFilePathSet}
 * separately). Feeds {@link applyParseErrorAdjustment}, which downgrades
 * a per-rule coverage row's confidence based on whether the rule's
 * eligible files include parse-error / partial-parse paths; finder-emitted
 * candidates would unfoundedly downgrade rule rows so they stay out of
 * this set. The doctrine-distinct "did anything emerge from this file?"
 * set used by `analysisCoverage`'s `parseErrorFiles` vs `partialParseFiles`
 * split lives in {@link outputFilePathSet} (-
 * MIXED-SIGNAL). Extracted so {@link assembleScanFamilyResponse} stays
 * under the cognitive-complexity cap.
 */
function violationFilePathSet(violations: readonly Violation[]): Set<string> {
  const out = new Set<string>();
  for (const v of violations) out.add(v.location.filePath);
  return out;
}

/**
 * Drives {@link buildSharedPerRuleCoverageMeta} from inside
 * {@link assembleScanFamilyResponse} and returns just the adjusted rows.
 * The wrapper exists so the caller passes a fixed input shape (the
 * conditional-spread for the optional `extensionsPresentAtRoot` lives
 * here, not at the call site) — keeps
 * {@link assembleScanFamilyResponse}'s cognitive complexity under the
 * lint cap. The shared helper's `fragment` slot is consumed downstream
 * by `tool-coverage.ts`, where the assembler-internal
 * {@link buildScanMeta} path doesn't reach; this seam discards it
 * because {@link buildScanMeta} re-derives the same fragment via the
 * underlying {@link perRuleCoverageMetaFragment} from the adjusted rows
 * it receives below.
 */
function runPerRuleCoverageCascade(args: {
  readonly perRuleCoverage: readonly PerRuleCoverage[];
  readonly parsedFiles: readonly ParsedFile[];
  readonly activeRules: readonly Rule[];
  readonly violationFilePaths: ReadonlySet<string>;
  readonly extensionsPresentAtRoot: ReadonlySet<string> | undefined;
  readonly verboseMeta: boolean;
}): readonly PerRuleCoverage[] {
  const { adjustedPerRuleCoverage } = buildSharedPerRuleCoverageMeta({
    perRuleCoverage: args.perRuleCoverage,
    parsedFiles: args.parsedFiles,
    activeRules: args.activeRules,
    violationFilePaths: args.violationFilePaths,
    ...(args.extensionsPresentAtRoot === undefined
      ? {}
      : { extensionsPresentAtRoot: args.extensionsPresentAtRoot }),
    verboseMeta: args.verboseMeta,
  });
  return adjustedPerRuleCoverage;
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
 * handlers (ADR 0024 /: forcing them through
 * the assembler would sum categorically different meta shapes), but
 * the `files` sub-tree is identical in kind: a sorted list of
 * `{ path, findings }` buckets where each finding is
 * `buildAgentFinding(v, { suppressPlacement: "omit" })`.
 *
 * when `sourcesByPath` is
 * supplied, the per-file source is threaded into each
 * `buildAgentFinding` call so mechanical-edit fixes (`fix.oldText` /
 * `fix.newText`) ride the same `widenToUniqueAnchor` ladder that
 * `suggest_fix.primary.edit` runs through. Both surfaces then ship
 * identical multi-line unique-context windows — an agent pasting
 * `fix.oldText` from a `scan_project` finding into `apply_fix` can't
 * silently clobber the first of N matching occurrences (canonical case:
 * 5 sibling `forms/label-adjacent-unassociated` findings whose
 * rule-emitted oldText is the bare 4-char literal `<label>`). Omit the
 * map at call sites that don't have parsed-file sources in scope; the
 * bare rule-emitted edit ships unwidened in that case.
 */
export function groupByFile(
  violations: readonly Violation[],
  sourcesByPath?: ReadonlyMap<string, string>,
): AssembledFile[] {
  const byPath = new Map<string, Violation[]>();
  for (const v of violations) {
    const bucket = byPath.get(v.location.filePath);
    if (bucket === undefined) byPath.set(v.location.filePath, [v]);
    else bucket.push(v);
  }
  const paths = [...byPath.keys()].sort();
  return paths.map((path) => {
    const bucketViolations = byPath.get(path) ?? [];
    const source = sourcesByPath?.get(path);
    const findings = bucketViolations.map((v) =>
      buildAgentFinding(v, {
        suppressPlacement: "omit",
        ...(source === undefined ? {} : { source }),
      }),
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
 * Pure over its inputs. The overlap check
 * reads `findings` out of `violations` + source out of `parsedFiles`
 * because both are already on the orchestrator's stack.
 */
/**
 * Decides whether the assembler should ship a deduped
 * `reviewCandidates[]` array, applying the per-candidate priority +
 * confidence resolver via the shared
 * {@link import("./review-candidate-priority.ts").resolvePriorityForCandidate}
 * helper. Extracted from {@link assembleScanFamilyResponse} so the
 * ternary + `?? new Map()` fallback don't push the orchestrator
 * function over the cognitive-complexity cap. Returns `undefined`
 * when the caller opted out (the surface is omitted entirely);
 * returns the deduped array otherwise (which may itself be empty
 * — the assembler's outer conditional-spread suppresses an empty
 * payload).
 */
function maybeDedupeReviewCandidates(args: {
  readonly options: ScanFamilyResponseOptions;
  readonly reviewCandidates: readonly ReviewCandidate[];
  readonly criterionLevels: ReadonlyMap<string, string> | undefined;
}): readonly DedupedReviewCandidate[] | undefined {
  const { options, reviewCandidates, criterionLevels } = args;
  if (options.includeReviewCandidates !== true) return undefined;
  return dedupeReviewCandidatesForSingleFile(reviewCandidates, criterionLevels ?? new Map());
}

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
  readonly configSearchedFromForWarning: string | undefined;
  readonly scssUnresolvedVariableFiles?: readonly string[];
  readonly linkedStylesheetsUnresolvedForContrast?: import("./scan-assembly.ts").LinkedStylesheetsUnresolvedForContrast;
  /**
   * Pre-computed cross-check for
   * `coverage_confidence_uniformly_high_with_parse_errors`. `true` when
   * every assembled `perRuleCoverage` row is `coverageConfidence: "high"`
   * with no `byFile` overrides; the warnings module pairs it with the
   * parse-error count for the emission gate.
   */
  readonly perRuleCoverageUniformlyHighWithParseErrors: boolean;
}): {
  readonly warnings?: readonly ScanWarningCode[];
  readonly warningsDetails?: ScanWarningDetails;
} {
  // `buildScanMeta` guarantees these are objects with the expected
  // shape — the Record<string, unknown> return forces a cast at the
  // consumption site. Safe because the producer is our own helper.
  const analysisCoverage = args.meta["analysisCoverage"] as Record<string, unknown> | undefined;
  const filesByExtension = args.meta["filesByExtension"] as Record<string, number> | undefined;
  const overlapResult = computeTemplateDirectiveOverlap({
    findings: args.violations.map((v) => ({
      filePath: v.location.filePath,
      line: v.location.line,
    })),
    sourcesByPath: new Map(args.parsedFiles.map((f) => [f.filePath, f.source])),
  });
  const templateDirectivesOverlap = overlapResult.overlap;
  // Combine the analysis-coverage accumulator's frontmatter-fence
  // file list (lifted onto `analysisCoverage.frontmatterFenceFiles`)
  // with the overlap-confirmed directive files so the warning's
  // `warningsDetails.template_files_parsed_as_literal.files` payload
  // names every file that contributed to the predicate. Empty when
  // neither emission path produced per-file evidence on this scan.
  const templateLiteralFiles = combineTemplateLiteralFiles(
    analysisCoverage,
    overlapResult.overlapFiles,
  );
  // Q-SHARED-META-ARRAY-BUDGET-CAP: the assembler-seam meta block
  // already carries the capped `analysisCoverage.*` arrays with
  // their per-array `*Truncated: { shown, total }` siblings; derive
  // the top-level `response_meta_truncated` code AND its paired
  // `warningsDetails.response_meta_truncated.fields` payload by
  // scanning meta for any truncation summary. `scannedBuildArtifacts`
  // is NOT assembled through this seam (`scan_project` handles it)
  // so only the coverage block's flags surface here — safe because
  // `getTruncatedMetaArrayFields` handles both containers uniformly.
  const metaArrayTruncatedFields = getTruncatedMetaArrayFields(args.meta);
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
    ...(templateLiteralFiles.length === 0 ? {} : { templateLiteralFiles }),
    ...(args.configSearchSawProjectMarker === undefined
      ? {}
      : { configSearchSawProjectMarker: args.configSearchSawProjectMarker }),
    ...(args.configSearchedFromForWarning === undefined
      ? {}
      : { configSearchedFromForWarning: args.configSearchedFromForWarning }),
    ...(metaArrayTruncatedFields.length > 0 ? { metaArrayTruncatedFields } : {}),
    ...(args.scssUnresolvedVariableFiles === undefined ||
    args.scssUnresolvedVariableFiles.length === 0
      ? {}
      : { scssUnresolvedVariableFiles: args.scssUnresolvedVariableFiles }),
    ...(args.linkedStylesheetsUnresolvedForContrast === undefined ||
    args.linkedStylesheetsUnresolvedForContrast.count === 0
      ? {}
      : {
          linkedStylesheetsUnresolvedForContrast: args.linkedStylesheetsUnresolvedForContrast,
        }),
    // present-when-meaningful; only fire the warning when the per-rule
    // axis pre-check resolved true (the warnings module then pairs it
    // with the parse-error count axis for the emission gate).
    ...(args.perRuleCoverageUniformlyHighWithParseErrors
      ? { perRuleCoverageUniformlyHighWithParseErrors: true as const }
      : {}),
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
    rawViolations,
    parsedFiles,
    activeRules,
    durationMs,
    enabledStandards,
    perRuleCoverage,
    filesWithAnyRuleEvaluated,
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
    configSearchedFromForWarning,
    criterionLevels,
  } = input;
  // Cross-surface count invariant: when the caller supplied raw
  // (pre-filter) violations, derive the parser/finder-honesty
  // `findingFilePaths` from them so this seam agrees with `coverage`
  // / `checklist` on identical input. Falls back to the post-filter
  // `violations` for legacy callers that didn't thread `rawViolations`
  // through; on those paths the count drifts the same way it did
  // before this change, but the documented `coverage` / `checklist`
  // surfaces (which always pass through `runScan` directly without
  // filters) stay aligned.
  const parseErrorViolations = rawViolations ?? violations;

  // (1) Group + build per-file findings. Thread the per-file source
  // text through so `buildAgentFinding` can run the same
  // `widenToUniqueAnchor` ladder that `suggest_fix.primary.edit` uses
  // — `fix.oldText` on a scan-family response and `primary.edit.oldText`
  // on a `suggest_fix` response now ship identical multi-line unique
  // anchors.
  const sourcesByPath = new Map<string, string>(parsedFiles.map((f) => [f.filePath, f.source]));
  let fileEntries: readonly AssembledFile[] = groupByFile(violations, sourcesByPath);

  // (2) Split notes from non-notes; tally fixes.
  const nonNote = violations.filter((v) => v.severity !== "info");
  const notes = violations.filter((v) => v.severity === "info");
  const { editsWithInlineFixPath, proseOnlySuggestions } = countFixes(nonNote);
  const violationsWithoutAnyFix = nonNote.length - editsWithInlineFixPath - proseOnlySuggestions;
  const fixesByClass = countFixesByClass(nonNote);

  // (3) Plan — honest conditional-spread counters live inside buildScanPlan.
  // The former `safeEdits` arg was removed per
  // Q-SHARED-SAFE-EDITS-VS-MECHANICAL-DISAGREEMENT; the structured
  // `fixesByClass` carries the honest per-lane signal. `summary` was
  // dropped per "Composite headline counts are dishonest" — the
  // structured siblings on the plan carry the same data without a
  // duplicated prose composite.
  const plan = buildScanPlan({
    violations: nonNote.length,
    notes: notes.length,
    violationsWithoutAnyFix,
    actionableManual,
    untargetedCriteria,
    fixesByClass,
  });

  // (4) Meta. Two distinct path sets — the doctrine difference is
  // load-bearing.
  // `violationFilePaths` (rules-only, pre-note-split so info-severity
  // notes still count as "rules fired") feeds
  // {@link applyParseErrorAdjustment}: a per-rule coverage row's
  // confidence may only be downgraded by evidence the same rule would
  // have produced (review candidates come from finders, not rules).
  // `outputFilePaths` (rules ∪ finders) feeds the `parseErrorFiles`
  // vs `partialParseFiles` split in {@link buildAnalysisCoverage}: that
  // bucket is doctrine for "did anything emerge from this file?", and
  // a file with grounded review candidates from a source-text finder
  // must NOT land in the `invisible-to-rules` bucket
  //.
  const violationFilePaths = violationFilePathSet(parseErrorViolations);
  const outputFilePaths = outputFilePathSet(parseErrorViolations, reviewCandidates);
  // route the rows
  // through the parse-error adjustment once so the meta block and the
  // top-level `ruleCoverage` derivative agree on which rules
  // confidently cleaned (parse-error files no longer count toward
  // `filesEvaluated`; partial-parse matches drop confidence to
  // `"low"`). No-op fast path when the scan has no parse errors.
  // chain a second adjustment
  // for `.scss` files where `$variable: …;` declarations produced no
  // literal-color usages — drops `coverageConfidence` to `"medium"`
  // with `coverageConfidenceReason: "scss-unresolved-variables"` so
  // a token-only theme partial doesn't read as `findings: []` /
  // `coverageConfidence: "high"`. Parse-error precedence is honored:
  // a row already at `"low"` keeps its existing reason.
  // `scssUnresolvedFiles` is shared with the warnings channel below
  // (`scssUnresolvedVariableFiles: scssUnresolvedFiles` arg to
  // `buildAssemblerWarningsField`) — kept as a local so the same file
  // list reaches both the per-rule cascade and the
  // `warningsDetails.scss_unresolved_variables.files` payload.
  const scssUnresolvedFiles = detectScssUnresolvedVariableFiles(parsedFiles);
  // The full adjustment cascade (parse-error → scss-unresolved →
  // fragment-input → scss-partial → extension-presence-subkind) lives
  // in the shared per-rule-coverage helper so the `coverage` tool emits
  // the same adjusted rows on identical input. Cross-surface count
  // invariant per `docs/kb/architecture/ai-first-consumer.md`. The
  // helper also formats the spreadable `meta.perRuleCoverage` /
  // `meta.perRuleCoverageSummary` fragment, but at this seam we still
  // route through {@link buildScanMeta} (which calls the same internal
  // {@link perRuleCoverageMetaFragment}) — the helper's `fragment` slot
  // is consumed by `tool-coverage.ts`, where the seam doesn't have a
  // {@link buildScanMeta} caller.
  const adjustedPerRuleCoverage = runPerRuleCoverageCascade({
    perRuleCoverage,
    parsedFiles,
    activeRules,
    violationFilePaths,
    extensionsPresentAtRoot: input.extensionsPresentAtRoot,
    verboseMeta,
  });
  // Per-finding confidence parity (in the
  // backlog; doctrine source: docs/kb/architecture/ai-first-consumer.md
  // "Per-finding confidence must reflect per-rule coverage limitations").
  // When the adjusted per-rule rows downgrade a rule's
  // `coverageConfidence`, propagate the structured reason code into
  // every per-finding `couldBeWrongBecause` for that rule so the
  // per-rule and per-finding layers don't ship contradictory
  // attention-budget signals in the same response. Additive — per-
  // finding `confidence` stays whatever the rule emitted; the cross-
  // file caveat the agent needs to triage with rides on the
  // `couldBeWrongBecause` axis. No-op fast path when no rule is
  // degraded (object identity stable on the common case).
  const perRuleLimitations = buildPerRuleLimitationMap(adjustedPerRuleCoverage);
  // File-scoped gate: the substrate codes `file_parse_error` and
  // `partial_parse` describe a per-file parse failure, not a corpus-
  // level evidence limitation. The propagation helper attaches them
  // only to findings whose file is in the corresponding parse-state
  // set. The same partitioning fed `applyParseErrorAdjustment` above —
  // sharing the predicate keeps the per-rule and per-finding layers
  // honest about the same file.
  const parseStateFiles = partitionParseStateFiles(parsedFiles, violationFilePaths);
  fileEntries = enrichFindingsWithPerRuleLimitations(
    fileEntries,
    perRuleLimitations,
    parseStateFiles,
  );
  // Per-finding confidence parity, per-FILE axis (sibling of the per-
  // RULE pass above). Doctrine source: docs/kb/architecture/ai-first-
  // consumer.md "Per-finding confidence must reflect per-rule coverage
  // limitations." When a finding fires inside a file the response also
  // surfaces under `meta.scannedBuildArtifacts` (jQuery distribution,
  // Bootstrap dist, livereload bundle, hashed Webpack output), the
  // sibling fields disagree silently if the per-finding layer ships
  // `confidence: "high"` next to a `scannedBuildArtifacts` entry that
  // labels the same file as generated bytes. Narrow gate: only rules in
  // {@link RULES_GATED_ON_BUILD_ARTIFACT_PATH} (currently
  // `keyboard/handler-missing` — its event-delegation false-positive is
  // the canonical case) get downgraded; broader opt-in would re-introduce
  // the silent-miss failure mode the doctrine warns against. No-op fast
  // path when the scan has no build artifacts (object identity stable on
  // the common case — authored-source repos pay no walk).
  const buildArtifactEntries = collectBuildArtifacts(parsedFiles);
  const buildArtifactPaths = new Set<string>(buildArtifactEntries.map((e) => e.path));
  fileEntries = enrichFindingsWithBuildArtifactPath(fileEntries, buildArtifactPaths);
  const meta = buildScanMeta({
    filesScanned: parsedFiles.length,
    ...(typeof filesWithAnyRuleEvaluated === "number" ? { filesWithAnyRuleEvaluated } : {}),
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
    findingFilePaths: outputFilePaths,
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
  // Threading happens inside {@link maybeDedupeReviewCandidates} so the
  // ternary + `?? new Map()` fallback don't bump this orchestrator
  // function over the cognitive-complexity cap.
  const dedupedCandidates = maybeDedupeReviewCandidates({
    options,
    reviewCandidates,
    criterionLevels,
  });

  // (8) Warnings channel — extracted to keep this orchestrator's
  // cognitive complexity inside the lint cap as new signals accrete.
  // Cross-reference parsed HTML inputs against
  // `<link rel="stylesheet" href="…">` references the contrast rule
  // does not consult during resolution, surfaced via the warning
  // channel per the AI-first "Routing skips that drop content are
  // the symmetric twin of suppression" doctrine.
  const linkedStylesheetsUnresolvedForContrast =
    detectLinkedStylesheetsNotResolvedForContrast(parsedFiles);
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
    configSearchedFromForWarning,
    scssUnresolvedVariableFiles: scssUnresolvedFiles,
    ...(linkedStylesheetsUnresolvedForContrast.count === 0
      ? {}
      : { linkedStylesheetsUnresolvedForContrast }),
    // Cross-check for the
    // `coverage_confidence_uniformly_high_with_parse_errors` warning;
    // the warnings module pairs the boolean with the parse-error count
    // for the emission gate.
    perRuleCoverageUniformlyHighWithParseErrors:
      isPerRuleCoverageUniformlyHigh(adjustedPerRuleCoverage),
  });

  // The three-totals `meta.countsBySurface` tripwire was dropped per
  // `docs/kb/architecture/ai-first-consumer.md` "Composite headline
  // counts are dishonest": a 4-way internal spread of disagreeing
  // finding totals (`plan` vs `perRuleCoverage` vs `filesSurface`,
  // each itself a sum across categorically different sub-buckets) was
  // the worst-case shape — it framed as cross-surface reconciliation
  // but read like an additional contested headline. Consumers that
  // need cross-surface reconciliation read the structured siblings
  // directly (`plan.fixesByClass`, `meta.perRuleCoverage`, the
  // per-file `findings.length` rollup); the headline summary the
  // tripwire collapsed those into hid the disagreement rather than
  // surfaced it. Deletion is the durable answer (same precedent as
  // `plan.totalFindings` / `plan.safeEditsAvailable` /
  // `plan.violations` / `plan.summary`).

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

  const trimmedFiles = budgetResult.files as readonly AssembledFile[];
  return {
    ...baseResponse,
    files: trimmedFiles,
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
