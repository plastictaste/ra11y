/**
 * Shared scan-time warning aggregator.
 *
 * Cross-surface invariant per `docs/kb/architecture/ai-first-consumer.md`
 * "Cross-surface count invariant" (warning-channel extension): the same
 * scan basis (cwd + parsed files + findings) MUST produce the same
 * scan-time warning code set on every project-rooted MCP tool that
 * consumes it (`scan_project`, `checklist`, `coverage`). Without a
 * single source for these predicates the codes drift — `scan_project`
 * surfaces `scanned_build_artifacts_present`, `checklist` silently
 * drops it, the agent calling both gets two different scan-confidence
 * pictures of one corpus, and the silent-miss failure mode is identical
 * to the count-disagreement case.
 *
 * Two warning categories distinguished here:
 *
 *   - **scan-time warnings** — predicate is a function of the scan
 *     basis (parsed files, findings, config-resolution state). The set
 *     produced by this helper. Identical across every project-rooted
 *     tool consuming the same cwd: `text_source_skipped`,
 *     `binary_assets_skipped`, `sourcemap_files_excluded`,
 *     `parse_errors_present`, `template_files_parsed_as_literal`,
 *     `scanned_build_artifacts_present`, `no_config_found`,
 *     `scanned_minified_file`, `bulk_catalog_detected`,
 *     `scss_unresolved_variables`, `vendor_css_dominates_findings`,
 *     `animation_library_without_reduced_motion_guard`,
 *     `dist_only_scan_detected`, `js_innerhtml_template_literal_unparsed`,
 *     etc.
 *
 *   - **response-instance warnings** — predicate is a function of the
 *     originating tool's own envelope construction (token-budget cap,
 *     meta-array head-slice cap, oversize-fallback file drop). NOT
 *     produced here. Each tool merges these onto the shared scan-time
 *     codes at its own assembly seam: `response_meta_truncated`,
 *     `response_token_budget_truncated`, `response_dropped_files_oversize`,
 *     `max_candidates_per_criterion_clamped`, `results_truncated_use_nextcursor`.
 *     They belong to the originating tool only and DO NOT propagate.
 *
 * The `bulk_catalog_detected` predicate has a duration component that
 * fires on `durationMs > SLOW_DURATION_MS`. Per-tool latency may differ
 * slightly on identical inputs, so each tool passes its own
 * `durationMs`; the deterministic bulk path
 * (`filesScanned > BULK_FILES_SCANNED_FLOOR`) stays cross-surface
 * because file count is identical for the same basis.
 */

import type { ParsedFile } from "../engine/scanner.ts";
import type { Violation } from "../types/violation.ts";
import {
  type BuildArtifactsGrouped,
  collectBuildArtifacts,
  groupBuildArtifactsByBasename,
  type ScannedBuildArtifact,
} from "./build-artifacts.ts";
import { type BulkCatalogDetection, detectBulkCatalog } from "./bulk-catalog.ts";
import {
  detectLinkedStylesheetsNotResolvedForContrast,
  detectScssUnresolvedVariableFiles,
  type LinkedStylesheetsUnresolvedForContrast,
} from "./scan-assembly.ts";
import {
  ANIMATION_LIB_GUARD_FINDING_FLOOR,
  computeTemplateDirectiveOverlap,
  type ScanWarningCode,
  type ScanWarningDetails,
  type WarningInputs,
  warningsField,
} from "./warnings.ts";

/**
 * Per-file findings shape the cross-surface aggregator needs. Both
 * `ScanFormatted.files[]` (scan_project) and per-file groupings of
 * `result.violations` (checklist / coverage) project down to this
 * shape, so the helpers stay agnostic of which tool called them.
 */
export interface PerFileFindings {
  readonly path: string;
  readonly findings: readonly { readonly ruleId: string; readonly line?: number }[];
}

/**
 * Inputs the call site passes to the shared aggregator. Every project-
 * rooted MCP tool already has the parsed-file + violation list pair;
 * the rest are scan-state flags and resolution paths each tool
 * computes once and threads through unchanged.
 */
export interface ScanTimeWarningInputs {
  readonly parsedFiles: readonly ParsedFile[];
  /** Violations from `runScan`. Used to derive per-file findings + total. */
  readonly violations: readonly Violation[];
  /** Resolved scan root — drives `no_config_found.searchedFrom`. */
  readonly root: string;
  /**
   * `null` when the loader walked the project tree and found nothing;
   * the absolute config path otherwise. Pass `undefined` only when the
   * tool intentionally skipped config resolution.
   */
  readonly configSource: string | null;
  /** True when the walk-up saw a `package.json` / `ra11y.config.*`. */
  readonly configSearchSawProjectMarker: boolean;
  /** How the scan root resolved. `null` for tools without root resolution. */
  readonly rootSource: WarningInputs["rootSource"];
  /** `analysisCoverage` block from `buildAnalysisCoverage`. */
  readonly analysisCoverage: Record<string, unknown> | undefined;
  readonly filesByExtension: Readonly<Record<string, number>>;
  /** Count of innerHTML/insertAdjacentHTML template-literal patterns declined. */
  readonly jsInnerHtmlDeclinedCount?: number;
  /**
   * Per-file inline-HTML pattern samples produced by
   * {@link import("../input/parsers/inline-html.ts").detectInlineHtmlPatternSamples}.
   * Cross-referenced post-scan against finding-bearing file paths so
   * only files where the routed parser produced zero findings surface
   * on `warningsDetails.js_innerhtml_template_literal_unparsed.fileSamples`.
   * Pass `undefined` when the tool did not run the detector (e.g.
   * scan-shape tools that only have a pre-resolved violation list with
   * no source files in hand).
   */
  readonly jsInnerHtmlPatternSamples?: ReadonlyMap<
    string,
    readonly { readonly path: string; readonly line: number; readonly pattern: string }[]
  >;
  /**
   * Per-tool latency. Drives `bulk_catalog_detected`'s slow path; the
   * deterministic bulk path (`filesScanned > BULK_FILES_SCANNED_FLOOR`)
   * stays cross-surface. Pass `undefined` when the tool does not
   * measure scan duration; the bulk-catalog code then drops
   * conservatively unless the file-count predicate fires.
   */
  readonly durationMs?: number;
  readonly storybookPresetActive?: boolean;
  readonly sessionWrappersMismatchCwd?: boolean;
  readonly additionalPathsRedundant?: boolean;
  readonly restrictToPathsEmpty?: boolean;
  readonly metaArrayTruncatedFields?: readonly string[];
  readonly nearestConfigAncestor?: string;
}

/**
 * Result. Per-tool callers spread the warnings fragment alongside their
 * own response-instance warnings (`response_meta_truncated`,
 * `response_token_budget_truncated`, etc.). The grouped build-artifact
 * payload is exposed too because `scan_project`'s meta block consumes
 * it directly and ungrouped/grouped views are co-derived from a single
 * `collectBuildArtifacts` pass.
 */
export interface ScanTimeWarningResult {
  readonly warnings?: readonly ScanWarningCode[];
  readonly warningsDetails?: ScanWarningDetails;
  /**
   * Build-artifact entries collected during predicate evaluation —
   * exposed so callers that also surface `meta.scannedBuildArtifacts`
   * reuse the same pass instead of re-classifying every file.
   */
  readonly buildArtifactEntries: readonly ScannedBuildArtifact[];
  /** Grouped view of the same entries, ready to spread under `meta`. */
  readonly buildArtifactsMetaField: { readonly scannedBuildArtifacts?: BuildArtifactsGrouped };
  /** SCSS files with unresolved variables — per-rule-coverage adjuster reads it. */
  readonly scssUnresolvedVariableFiles: readonly string[];
}

/**
 * Aggregates the canonical scan-time warning channel for a project-
 * rooted MCP tool. Every project-rooted tool calls this with its own
 * scan-basis snapshot; the resulting `{ warnings, warningsDetails }`
 * fragment is identical for identical inputs (modulo the duration-
 * dependent bulk-catalog slow path documented in the file header).
 *
 * Intentionally NOT a thin wrapper over `warningsField` — the helper
 * runs the build-artifact + scss + animation-library + vendor-css
 * predicates here so call sites don't duplicate them. Response-
 * instance codes (token-budget / meta-array / oversize) are NOT
 * computed here; each tool merges those at its own assembly seam.
 */
export function buildScanTimeWarnings(inputs: ScanTimeWarningInputs): ScanTimeWarningResult {
  const derived = deriveBuildArtifactSignals(inputs);
  const fragment = warningsField(buildWarningsFieldInputs(inputs, derived));
  return {
    ...(fragment.warnings === undefined ? {} : { warnings: fragment.warnings }),
    ...(fragment.warningsDetails === undefined
      ? {}
      : { warningsDetails: fragment.warningsDetails }),
    buildArtifactEntries: derived.buildArtifactEntries,
    buildArtifactsMetaField: derived.buildArtifactsMetaField,
    scssUnresolvedVariableFiles: derived.scssUnresolvedVariableFiles,
  };
}

/**
 * Internal: collects every build-artifact-derived signal needed by the
 * scan-time warnings predicate. Single pass over the parsed-file list +
 * the violation list keeps the helper allocation-free aside from the
 * grouped maps the predicates already need; extracted from
 * `buildScanTimeWarnings` so the orchestrator's cognitive complexity
 * stays under the lint cap.
 */
interface DerivedBuildArtifactSignals {
  readonly buildArtifactEntries: readonly ScannedBuildArtifact[];
  readonly buildArtifactsMetaField: { readonly scannedBuildArtifacts?: BuildArtifactsGrouped };
  readonly scssUnresolvedVariableFiles: readonly string[];
  readonly perFileFindings: readonly PerFileFindings[];
  readonly vendorCssNoise: WarningInputs["vendorCssNoise"] | undefined;
  readonly scannedMinifiedFiles: readonly string[];
  readonly animationLibraryGuardCandidates: ReturnType<
    typeof computeAnimationLibraryGuardCandidates
  >;
  readonly scannedBuildArtifactsSummary: WarningInputs["scannedBuildArtifactsSummary"];
  readonly scannedBuildArtifactsAllFiles: boolean;
  readonly bulkCatalogDetection: BulkCatalogDetection | undefined;
  readonly templateDirectivesOverlap: boolean;
  readonly templateLiteralFiles: readonly string[];
  readonly filesScanned: number;
  readonly totalFindings: number;
  readonly jsInnerHtmlFileSamples: readonly {
    readonly path: string;
    readonly line: number;
    readonly pattern: string;
  }[];
  readonly linkedStylesheetsUnresolvedForContrast: LinkedStylesheetsUnresolvedForContrast;
  readonly jsRoutedThroughTsxSucceededCount: number;
}

function deriveBuildArtifactSignals(inputs: ScanTimeWarningInputs): DerivedBuildArtifactSignals {
  const buildArtifactEntries = collectBuildArtifacts(inputs.parsedFiles);
  const grouped = groupBuildArtifactsByBasename(buildArtifactEntries, inputs.root);
  const buildArtifactsMetaField: { readonly scannedBuildArtifacts?: BuildArtifactsGrouped } =
    buildArtifactEntries.length > 0 ? { scannedBuildArtifacts: grouped } : {};

  const scssUnresolvedVariableFiles = detectScssUnresolvedVariableFiles(inputs.parsedFiles);
  const perFileFindings = groupViolationsByFile(inputs.violations);
  const vendorCssNoise = computeVendorCssNoise(buildArtifactEntries, perFileFindings);

  const scannedMinifiedFiles = buildArtifactEntries
    .filter(
      (e) =>
        e.classification === "definite-min-infix" ||
        e.classification === "likely-minified-by-line-stats",
    )
    .map((e) => e.path);

  const vendorLibraries = grouped.vendorLibraries ?? [];
  const animationLibraryGuardCandidates = computeAnimationLibraryGuardCandidates({
    vendorLibraries,
    files: perFileFindings,
  });

  const totalFindings = inputs.violations.length;
  const filesScanned = inputs.parsedFiles.length;

  const scannedBuildArtifactsSummary =
    buildArtifactEntries.length > 0
      ? {
          count: buildArtifactEntries.length,
          ...(buildArtifactEntries[0]?.path === undefined
            ? {}
            : { topPath: buildArtifactEntries[0].path }),
        }
      : undefined;

  const scannedBuildArtifactsAllFiles =
    filesScanned > 0 && buildArtifactEntries.length === filesScanned;

  const bulkCatalogDetection: BulkCatalogDetection | undefined =
    inputs.durationMs === undefined
      ? undefined
      : detectBulkCatalog({
          durationMs: inputs.durationMs,
          filesScanned,
          buildArtifacts: buildArtifactEntries,
        });

  const overlapResult = computeTemplateDirectiveOverlap({
    findings: inputs.violations.map((v) => ({
      filePath: v.location.filePath,
      line: v.location.line,
    })),
    sourcesByPath: new Map(inputs.parsedFiles.map((f) => [f.filePath, f.source])),
  });
  const templateDirectivesOverlap = overlapResult.overlap;
  // Combine per-file frontmatter evidence (lifted off the coverage
  // accumulator) with the overlap-confirmed directive files so the
  // warning channel's payload names every file that contributed to
  // the `template_files_parsed_as_literal` predicate. Empty when
  // neither emission path produced per-file evidence on this scan.
  const templateLiteralFiles = combineTemplateLiteralFiles(
    inputs.analysisCoverage,
    overlapResult.overlapFiles,
  );

  // Per-file inline-HTML pattern samples are surfaced only for files
  // where the routed parser produced zero findings — the routing-skip
  // failure mode the doctrine names. Cross-reference once at the
  // aggregator seam; the per-tool call site already populated the
  // detector map at parse time.
  const findingBearingPaths = new Set<string>();
  for (const f of perFileFindings) findingBearingPaths.add(f.path);
  const jsInnerHtmlFileSamples = collectInlineHtmlFileSamples(
    inputs.jsInnerHtmlPatternSamples,
    findingBearingPaths,
  );

  // Cross-reference parsed HTML inputs against
  // `<link rel="stylesheet" href="…">` references the contrast rule
  // does not consult during resolution. The detector is pure over the
  // parsed-file list; the predicate fires when at least one HTML page
  // declares an unresolved link, which is enough evidence for the
  // warning channel to surface the silent omission per the AI-first
  // "Routing skips that drop content are the symmetric twin of
  // suppression" doctrine.
  const linkedStylesheetsUnresolvedForContrast = detectLinkedStylesheetsNotResolvedForContrast(
    inputs.parsedFiles,
  );

  // Count `.js` files successfully routed through the TSX parser —
  // canonical content-drop hazard the AI-first doctrine names ("the
  // parser bails on relational expressions read as JSX"). The `.js` →
  // tsx aliasing is invisible to a caller reading the response, so
  // surfacing the routing decision lets the agent decide whether to
  // spot-check the file or scope around it.
  const jsRoutedThroughTsxSucceededCount = countJsRoutedThroughTsxSucceeded(inputs.parsedFiles);

  return {
    buildArtifactEntries,
    buildArtifactsMetaField,
    scssUnresolvedVariableFiles,
    perFileFindings,
    vendorCssNoise,
    scannedMinifiedFiles,
    animationLibraryGuardCandidates,
    scannedBuildArtifactsSummary,
    scannedBuildArtifactsAllFiles,
    bulkCatalogDetection,
    templateDirectivesOverlap,
    templateLiteralFiles,
    filesScanned,
    totalFindings,
    jsInnerHtmlFileSamples,
    linkedStylesheetsUnresolvedForContrast,
    jsRoutedThroughTsxSucceededCount,
  };
}

/**
 * Builds the per-file evidence list backing
 * `warningsDetails.template_files_parsed_as_literal.files`. Combines
 * the analysis-coverage accumulator's `frontmatterFenceFiles` (lifted
 * onto the coverage block by `buildAnalysisCoverage`) with the
 * overlap-confirmed directive files returned by
 * {@link computeTemplateDirectiveOverlap}. Both subsets are file-path
 * lists; the warning's predicate fires on the union so the payload
 * names every file that contributed.
 *
 * Pure over its inputs — sorted union, deduped via `Set`. Returns an
 * empty array when neither subset contributed evidence; the caller
 * conditional-spreads the field away in that case so the wire shape
 * stays present-when-meaningful.
 */
export function combineTemplateLiteralFiles(
  analysisCoverage: Record<string, unknown> | undefined,
  overlapFiles: ReadonlySet<string>,
): readonly string[] {
  const out = new Set<string>();
  if (analysisCoverage !== undefined) {
    const fence = analysisCoverage["frontmatterFenceFiles"];
    if (Array.isArray(fence)) {
      for (const path of fence) if (typeof path === "string") out.add(path);
    }
  }
  for (const path of overlapFiles) out.add(path);
  if (out.size === 0) return [];
  return [...out].sort();
}

/**
 * Counts files in the parsed-file list whose extension is `.js` (case-
 * insensitive) AND whose AST recorded zero parse errors. The `.js`
 * extension is the only `.js`-family extension routed by
 * {@link import("./session.ts").McpSession.parseFile} through the TSX
 * parser today (`.mjs` / `.cjs` are not in
 * {@link import("../utils/path.ts").PARSEABLE_EXTENSIONS}); broadening
 * the predicate to those would silently fire the warning on file shapes
 * that never reach the parser. Pure over its input — the per-tool
 * caller threads `parsedFiles` and the count is computed once at the
 * aggregator seam.
 *
 * The `errors.length === 0` filter narrows the predicate to
 * "successfully parsed" — files in the parse-error / partial-parse
 * buckets are already covered by `parse_errors_present` and
 * `parser_bailed_zero_findings`. The doctrine framing is "the routing
 * decision is itself the silent-miss hazard"; a clean parse on a `.js`
 * file is the case the existing parse-error codes can't surface.
 */
function countJsRoutedThroughTsxSucceeded(parsedFiles: readonly ParsedFile[]): number {
  let count = 0;
  for (const file of parsedFiles) {
    if (!file.filePath.toLowerCase().endsWith(".js")) continue;
    if (file.ast.errors.length > 0) continue;
    count += 1;
  }
  return count;
}

/**
 * Cross-references the per-file inline-HTML pattern map with the post-
 * scan finding-bearing path set, returning up to one sample per file
 * for paths NOT in the finding-bearing set. Caller's detector already
 * capped per-file entries at {@link import("../input/parsers/inline-html.ts").INLINE_HTML_PATTERN_SAMPLE_CAP};
 * we keep one representative per file (the lowest-line, first-pattern
 * entry) so the wire payload scales with file count rather than total
 * pattern instances. Per CLAUDE.md §1 "Surface, don't suppress" — each
 * file's first sample is enough for the agent to grep + investigate;
 * the rest are reachable via `Grep` on the cited patterns.
 */
function collectInlineHtmlFileSamples(
  perFileSamples:
    | ReadonlyMap<
        string,
        readonly { readonly path: string; readonly line: number; readonly pattern: string }[]
      >
    | undefined,
  findingBearingPaths: ReadonlySet<string>,
): readonly { readonly path: string; readonly line: number; readonly pattern: string }[] {
  if (perFileSamples === undefined || perFileSamples.size === 0) return [];
  const out: { readonly path: string; readonly line: number; readonly pattern: string }[] = [];
  for (const [path, samples] of perFileSamples) {
    if (findingBearingPaths.has(path)) continue;
    const head = samples[0];
    if (head === undefined) continue;
    out.push(head);
  }
  return out;
}

/**
 * Internal: assembles the `WarningInputs` bag for the canonical
 * `warningsField` call. Conditional-spreads omit fields whose
 * downstream codes do not fire — `warningsField` treats absent and
 * default-falsy identically, but the explicit conditional spread keeps
 * the call site auditable.
 */
function buildWarningsFieldInputs(
  inputs: ScanTimeWarningInputs,
  derived: DerivedBuildArtifactSignals,
): WarningInputs {
  return {
    filesScanned: derived.filesScanned,
    totalFindings: derived.totalFindings,
    rootSource: inputs.rootSource,
    configSource: inputs.configSource,
    configSearchedFromForWarning: inputs.root,
    analysisCoverage: inputs.analysisCoverage,
    filesByExtension: inputs.filesByExtension,
    scannedBuildArtifactsPresent: derived.buildArtifactEntries.length > 0,
    ...(derived.scannedBuildArtifactsSummary === undefined
      ? {}
      : { scannedBuildArtifactsSummary: derived.scannedBuildArtifactsSummary }),
    ...(derived.scannedBuildArtifactsAllFiles ? { scannedBuildArtifactsAllFiles: true } : {}),
    ...(inputs.storybookPresetActive ? { storybookPresetActive: true } : {}),
    ...(inputs.sessionWrappersMismatchCwd ? { sessionWrappersMismatchCwd: true } : {}),
    templateDirectivesOverlap: derived.templateDirectivesOverlap,
    ...templateLiteralInputs(derived.templateLiteralFiles),
    ...(inputs.additionalPathsRedundant ? { additionalPathsRedundant: true } : {}),
    ...(inputs.restrictToPathsEmpty ? { restrictToPathsEmpty: true } : {}),
    configSearchSawProjectMarker: inputs.configSearchSawProjectMarker,
    ...(inputs.metaArrayTruncatedFields === undefined
      ? {}
      : { metaArrayTruncatedFields: inputs.metaArrayTruncatedFields }),
    ...(derived.vendorCssNoise === undefined ? {} : { vendorCssNoise: derived.vendorCssNoise }),
    ...(derived.scssUnresolvedVariableFiles.length === 0
      ? {}
      : { scssUnresolvedVariableFiles: derived.scssUnresolvedVariableFiles }),
    ...(derived.scannedMinifiedFiles.length === 0
      ? {}
      : { scannedMinifiedFiles: derived.scannedMinifiedFiles }),
    ...(derived.bulkCatalogDetection === undefined
      ? {}
      : { bulkCatalogDetection: derived.bulkCatalogDetection }),
    ...(derived.animationLibraryGuardCandidates.length === 0
      ? {}
      : { animationLibraryGuardCandidates: derived.animationLibraryGuardCandidates }),
    ...inlineHtmlInputs(inputs.jsInnerHtmlDeclinedCount, derived.jsInnerHtmlFileSamples),
    ...(inputs.nearestConfigAncestor === undefined
      ? {}
      : { nearestConfigAncestor: inputs.nearestConfigAncestor }),
    ...(derived.linkedStylesheetsUnresolvedForContrast.count === 0
      ? {}
      : {
          linkedStylesheetsUnresolvedForContrast: derived.linkedStylesheetsUnresolvedForContrast,
        }),
    ...(derived.jsRoutedThroughTsxSucceededCount === 0
      ? {}
      : { jsRoutedThroughTsxSucceededCount: derived.jsRoutedThroughTsxSucceededCount }),
  };
}

/**
 * Builds the spreadable template-literal-files subset of
 * {@link WarningInputs}. Conditional-spread per the
 * present-when-meaningful contract: empty list omits the field, non-
 * empty carries the path list. Drives the
 * `warningsDetails.template_files_parsed_as_literal: { files, extensions }`
 * payload at the warnings-module seam. Extracted from
 * {@link buildWarningsFieldInputs} so the orchestrator stays under the
 * cognitive-complexity cap as new evidence axes accrete.
 */
function templateLiteralInputs(files: readonly string[]): Partial<WarningInputs> {
  return files.length === 0 ? {} : { templateLiteralFiles: files };
}

/**
 * Builds the spreadable inline-HTML axis subset of {@link WarningInputs}.
 * Both fields are conditional-spread per the
 * present-when-meaningful contract: declined > 0 → carry the count;
 * samples non-empty → carry the array. Either axis (or both) drives
 * `js_innerhtml_template_literal_unparsed`. Extracted from
 * {@link buildWarningsFieldInputs} so the orchestrator stays under
 * the cognitive-complexity cap as new evidence axes accrete.
 */
function inlineHtmlInputs(
  declinedCount: number | undefined,
  fileSamples: readonly {
    readonly path: string;
    readonly line: number;
    readonly pattern: string;
  }[],
): Partial<WarningInputs> {
  const decl =
    typeof declinedCount === "number" && declinedCount > 0
      ? { jsInnerHtmlDeclinedCount: declinedCount }
      : {};
  const sam = fileSamples.length === 0 ? {} : { jsInnerHtmlFileSamples: fileSamples };
  return { ...decl, ...sam };
}

/**
 * Projects a flat violation list down to per-file findings. Stable
 * insertion order so downstream walks are deterministic across runs.
 */
function groupViolationsByFile(violations: readonly Violation[]): readonly PerFileFindings[] {
  const byPath = new Map<string, { ruleId: string; line?: number }[]>();
  for (const v of violations) {
    const path = v.location.filePath;
    let bucket = byPath.get(path);
    if (bucket === undefined) {
      bucket = [];
      byPath.set(path, bucket);
    }
    bucket.push({ ruleId: v.ruleId, line: v.location.line });
  }
  const out: PerFileFindings[] = [];
  for (const [path, findings] of byPath) out.push({ path, findings });
  return out;
}

/**
 * Cross-references the build-artifact detector's CSS-extension subset
 * with per-file findings to drive `vendor_css_dominates_findings`.
 * Returns `undefined` when the scan produced zero findings — the
 * dominance question isn't meaningful on a clean scan.
 */
export function computeVendorCssNoise(
  buildArtifacts: readonly ScannedBuildArtifact[],
  files: readonly PerFileFindings[],
): WarningInputs["vendorCssNoise"] | undefined {
  const vendorCssPaths = new Set<string>();
  for (const artifact of buildArtifacts) {
    const lower = artifact.path.toLowerCase();
    if (lower.endsWith(".css") || lower.endsWith(".scss")) {
      vendorCssPaths.add(artifact.path);
    }
  }
  let totalFindingsCount = 0;
  let vendorFindingsCount = 0;
  let topVendorFile: { readonly path: string; readonly findingsCount: number } | undefined;
  for (const file of files) {
    const count = file.findings.length;
    totalFindingsCount += count;
    if (vendorCssPaths.has(file.path)) {
      vendorFindingsCount += count;
      if (topVendorFile === undefined || count > topVendorFile.findingsCount) {
        topVendorFile = { path: file.path, findingsCount: count };
      }
    }
  }
  if (totalFindingsCount === 0) return undefined;
  return {
    totalFindingsCount,
    vendorFindingsCount,
    ...(topVendorFile === undefined ? {} : { topVendorFile }),
  };
}

/**
 * Cross-references banner-detected vendor libraries with per-rule per-
 * file finding counts. Returns the `(ruleId, file, findingCount,
 * library, suggestion)` tuples for every (ruleId, file) pair where the
 * file is in `vendorLibraries[]` (deterministic banner-comment match)
 * AND the rule emitted ≥ {@link ANIMATION_LIB_GUARD_FINDING_FLOOR}
 * findings on that file.
 */
export function computeAnimationLibraryGuardCandidates(args: {
  readonly vendorLibraries: readonly import("./build-artifacts.ts").DetectedVendorLibrary[];
  readonly files: readonly PerFileFindings[];
}): readonly {
  readonly ruleId: string;
  readonly file: string;
  readonly findingCount: number;
  readonly library: string;
  readonly suggestion: string;
}[] {
  if (args.vendorLibraries.length === 0) return [];
  const libraryByPath = new Map<string, string>();
  for (const lib of args.vendorLibraries) libraryByPath.set(lib.path, lib.library);
  const out: {
    readonly ruleId: string;
    readonly file: string;
    readonly findingCount: number;
    readonly library: string;
    readonly suggestion: string;
  }[] = [];
  for (const file of args.files) {
    const library = libraryByPath.get(file.path);
    if (library === undefined) continue;
    const perRule = new Map<string, number>();
    for (const finding of file.findings) {
      perRule.set(finding.ruleId, (perRule.get(finding.ruleId) ?? 0) + 1);
    }
    for (const [ruleId, findingCount] of perRule) {
      if (findingCount < ANIMATION_LIB_GUARD_FINDING_FLOOR) continue;
      out.push({
        ruleId,
        file: file.path,
        findingCount,
        library,
        suggestion: animationLibraryGuardSuggestion({ library, ruleId, findingCount }),
      });
    }
  }
  return out;
}

/**
 * Library-aware remediation prose surfaced on the warningsDetails
 * payload for `animation_library_without_reduced_motion_guard`.
 */
function animationLibraryGuardSuggestion(args: {
  readonly library: string;
  readonly ruleId: string;
  readonly findingCount: number;
}): string {
  if (args.ruleId.startsWith("motion/")) {
    return `Wrap the \`${args.library}\` import (e.g. \`@import\`, \`<link rel="stylesheet">\`, or a bundler-side import) in \`@media (prefers-reduced-motion: no-preference) { ... }\`. One wrap addresses all ${args.findingCount} \`${args.ruleId}\` findings on this file.`;
  }
  return `Consider adding the \`${args.library}\` distribution to the \`exclude\` glob in \`ra11y.config.ts\`, or scoping it under a source-level disable pragma. One change addresses all ${args.findingCount} \`${args.ruleId}\` findings on this file.`;
}
