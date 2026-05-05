/**
 * The `scan_file` MCP tool. Scans a single file with cached ASTs so the
 * fix-verify loop (edit → re-scan) stays fast. Lives in its own file so
 * `src/mcp/tools.ts` stays focused on tool schemas and inventory.
 *
 * Response shape is the historical flat-findings form:
 * `{ findings, reviewCandidates?, plan, referenceGuide?, warnings?,
 * warningsDetails?, meta }`. Agents iterating the fix-verify loop key
 * off the flat `findings` array rather than the grouped `files[]` that
 * the rest of the scan family emits. Assembly routes through
 * {@link assembleScanFamilyResponse} per — the
 * handler owns only the tool-specific shape adaptation (flatten
 * `files[0].findings`) and the outer fields (`scanned`,
 * `configSource`, `configSearchedFrom`, `nextStep`).
 */

import { isAbsolute, resolve } from "node:path";
import { filterPerRuleCoverageForSingleFile } from "../engine/per-rule-coverage.ts";
import type { ParsedFile } from "../engine/scanner.ts";
import type { LoadedConfig } from "../types/config.ts";
import type { Rule } from "../types/rule.ts";
import type { PerRuleCoverage } from "../types/violation.ts";
import {
  extension as fileExtension,
  naturalParserFor,
  parseableExtensions,
} from "../utils/path.ts";
import { collectBuildArtifacts } from "./build-artifacts.ts";
import { sawProjectMarkerInWalk } from "./config-search-marker.ts";
import { buildFileLimitation, type FileLimitation } from "./file-limitations.ts";
import { applyMetaCacheMode, metaModeSchema } from "./meta-cache.ts";
import { buildNextStep } from "./next-step.ts";
import { requireBooleanParam } from "./param-validators.ts";
import { pathExists } from "./path-exists.ts";
import { resolveInsideCwd } from "./resolve-inside-cwd.ts";
import { assembleScanFamilyResponse, type ScanFamilyResponse } from "./response-assembler.ts";
import { buildCriterionLevelMap } from "./review-candidate-priority.ts";
import { withViolationsByScanKind } from "./scan-assembly.ts";
import { runScanAndCollect, type ScanCollected } from "./scan-collect.ts";
import { applyScanFileBudget } from "./scan-file-budget.ts";
import { buildScanTimeWarnings } from "./scan-time-warnings.ts";
import { scannedFile } from "./scanned-envelope.ts";
import { configSearchedFromField } from "./scanner-meta.ts";
import type { McpSession } from "./session.ts";
import {
  errorResult,
  type McpTool,
  type McpToolResult,
  numParam,
  resolveStandards,
  strParam,
  textResult,
} from "./tools-helpers.ts";
import type { WarningInputs } from "./warnings.ts";
import { buildWrapperSourcesFromConfig } from "./wrappers-meta.ts";

// Remediation string for the `file-unsupported` envelope emitted by
// `scan_file`, built from `parseableExtensions()` so the message stays
// honest as the parser registry grows — a new `.vue` or `.svelte`
// parser lands in src/utils/path.ts's `PARSEABLE_EXTENSIONS` and the
// remediation updates in lockstep, rather than drifting into a stale
// hardcoded list at the `file-unsupported` early-exit site below.
// `file-not-found` carries a separate remediation that frames the
// path-on-disk check (distinct from the extension-not-supported case
// per Q-SHARED-SCAN-FILE-ERROR-DISCRIMINATION) so the agent branches
// on the right recovery without re-reading prose.
const SCAN_FILE_UNSUPPORTED_REMEDIATION = `Pass a file with one of these extensions: ${parseableExtensions().join(", ")}.`;
const SCAN_FILE_NOT_FOUND_REMEDIATION =
  "Verify the path exists on disk. Relative paths resolve against `cwd` (defaults to the MCP server's spawn directory).";
const SCAN_FILE_READ_FAILED_REMEDIATION =
  "The file exists and has a supported extension, but the scanner could not read or parse it. Inspect `details.cause`; fix permissions or encoding issues, then retry.";

export const scanFileTool: McpTool = {
  def: {
    name: "scan_file",
    description:
      "Scan a single file for accessibility violations. Fast with cached ASTs — use for the fix-verify loop after editing a file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to scan." },
        standard: { type: "string", description: "Standard ID. Defaults to session config." },
        level: { type: "string", enum: ["A", "AA", "AAA"], description: "Conformance level." },
        minSeverity: {
          type: "string",
          enum: ["error", "warning", "info"],
          description:
            "Minimum severity to include. Default 'info' is recommended — info findings are cases static analysis can't resolve but you can (by reading component source / cross-file references). Only raise to 'warning' for unattended CI gates.",
        },
        cwd: {
          type: "string",
          description: "Base directory for resolving the path if it is relative.",
        },
        verboseMeta: {
          type: "boolean",
          description:
            "When true, the response includes the full `meta.perRuleCoverage[]` array (per-rule coverage rows with concentration / parse-error confidence reasons; at default verbosity replaced by `perRuleCoverageSummary: { ruleCount, ruleIds }`) plus the `analysisCoverage` block with parse-error and opaque-component details, plus `rulesEligibleByExtension` so you can verify which rules were eligible to run on this file's type. The scan-confidence telemetry (`rulesEvaluated`, `filesWithAnyRuleEvaluated` / `filesWithZeroRuleEvaluation`, `rulesNotEvaluatedDueToInputType`) stays inline at every verbosity. Off by default to keep per-file responses bounded on dense HTML; enable when triaging which rules ran on this file.",
        },
        limit: {
          type: "number",
          description:
            "Maximum number of findings to include in the response. Defaults to 200 — typical pages produce well under this so the cap is a no-op for most calls. Dense HTML pages (e.g. component-library entry-points with 600+ findings) cross the MCP host token ceiling without paging; when the inventory exceeds `limit`, the response carries `truncated: true` + `nextOffset: N` and `totalFindings: <full count>` so the caller can page via `offset`. Pass `0` to disable paging entirely.",
        },
        offset: {
          type: "number",
          description:
            "Starting index into the full findings list. Defaults to 0. Use with `limit` + the `nextOffset` from a previous truncated response to iterate.",
        },
        maxBytes: {
          type: "number",
          description:
            "Override the host-ceiling sentinel that triggers the minimum-honest envelope fallback (`response_dropped_files_oversize`). Defaults to ~96000 chars (~25k tokens). Lower values force the slim envelope earlier — useful for hosts with tighter token walls or for testing the fallback shape on tractable fixtures. Most callers should leave this unset.",
        },
        metaMode: metaModeSchema,
      },
      required: ["path"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async handler(params, session) {
    // Up-front type check: a wrong-type `verboseMeta` (e.g. `1`,
    // `"true"`) used to be silently treated as `false` and the
    // expanded meta block never shipped. Closes the silent-drop class
    // for this handler.
    const verboseMetaCheck = requireBooleanParam(params, "verboseMeta");
    if (!verboseMetaCheck.ok) return errorResult(verboseMetaCheck.error);
    const filePath = strParam(params, "path");
    if (!filePath || filePath.length === 0) {
      return errorResult({
        code: "missing-required-param",
        message: "path must be a non-empty string.",
        details: { param: "path" },
      });
    }

    // Q-SHARED-SCAN-FILE-ERROR-DISCRIMINATION: split the umbrella
    // `file-unsupported` code into three distinct codes matching the
    // `suppress` tool's three-code convention so an agent can branch
    // on the actual failure mode:
    //   - `file-not-found`     — path does not exist on disk
    //   - `file-unsupported`   — extension not in PARSEABLE_EXTENSIONS
    //   - `file-read-failed`   — exists + supported, but IO/permission
    //                            blocked the read or parse
    // Doctrine: "Ambiguous field shapes are dishonest." One code per
    // failure mode so the agent's recovery action (retry on permission
    // fix, pick a different file on extension mismatch, re-check the
    // path on not-found) stays deterministic.
    const scanFileCwd = strParam(params, "cwd");
    // reject paths that escape the
    // declared `cwd` sandbox before any fs access. Mirrors the guard
    // apply_fix and suppress already enforce on their (cwd, file)
    // inputs — every read-or-write tool accepting a explicit
    // `(cwd, path)` pair must check the same boundary so agents form
    // a single mental model of the escape envelope. The guard only
    // fires when `cwd` is explicitly set: without a declared
    // sandbox, the read-only `scan_file` / `suggest_fix` call is a
    // "scan this absolute path" request with no containment claim,
    // so there is nothing to enforce. The write tools (apply_fix,
    // suppress) default cwd to process.cwd() and enforce
    // unconditionally because an implicit sandbox is still a
    // sandbox when a write is about to happen.
    if (scanFileCwd !== undefined && (await resolveInsideCwd(filePath, scanFileCwd)) === null) {
      return pathEscapesCwdResult(filePath, scanFileCwd);
    }
    if (!(await pathExists(filePath, scanFileCwd))) {
      return fileNotFoundResult(filePath);
    }

    let parsed: ParsedFile | null;
    try {
      parsed = await session.parseFile(filePath, scanFileCwd);
    } catch (err) {
      return fileReadFailedResult(filePath, err);
    }
    if (!parsed) return unsupportedExtensionResult(filePath);

    // Resolve the directory to search for ra11y.config.* and to feed the
    // scanner. Mirrors scan_project's precedence: explicit cwd wins;
    // otherwise we walk up from the file's own directory so the loader
    // can still find a project config when the agent didn't pass cwd.
    const absFilePath = isAbsolute(filePath)
      ? filePath
      : resolve(scanFileCwd ?? process.cwd(), filePath);
    const configSearchBase =
      scanFileCwd ?? (absFilePath.slice(0, absFilePath.lastIndexOf("/")) || process.cwd());
    const projectConfig = await session.loadProjectConfig(configSearchBase);
    // Q-SHARED-NO-CONFIG-WARNING-TINY-REPO: probe the walk-up range the
    // config loader searched so the warning gate distinguishes
    // "file-only scratch scan" from "real Node project where the
    // config is plausibly missing." Only relevant when no config
    // loaded; the flag is ignored otherwise.
    const configSearchSawProjectMarker =
      projectConfig.sourcePath === null ? sawProjectMarkerInWalk(configSearchBase) : false;
    const standards = resolveStandards(strParam(params, "standard"), session);

    const collected = await runScanAndCollect({
      files: [parsed],
      session,
      enabled: standards,
      minSeverity: strParam(params, "minSeverity"),
      ruleSettings: session.effectiveRules(projectConfig),
      wrapperSources: buildWrapperSourcesFromConfig(projectConfig, session),
      cwd: configSearchBase,
    });
    // Single-file scans never strain the density cap — disable
    // (`tokenBudget: 0`) so the assembler returns the full response
    // even on pathological single files rather than emitting a stump
    // `truncated: true` that the caller can't page past (`scan_file`
    // has no pagination axis).
    //
    // `includeReviewCandidates: true`: scan_file's historical shape
    // carries `reviewCandidates` on the response for the fix-verify
    // loop. The assembler does the per-file dedupe via
    // `dedupeReviewCandidatesForSingleFile` when this option is on,
    // and conditional-spreads the field so empty scans omit it (honest
    // present-when-meaningful shape).
    //
    // `rootSource: null`: scan_file has no project-root concept — the
    // file IS the scope. Null suppresses the `root_source_defaulted`
    // warning, which is a scan_project-only signal.
    const assembled = assembleScanFamilyResponse(
      {
        ...collected,
        verboseMeta: params["verboseMeta"] === true,
        preset: projectConfig.preset,
        configSource: projectConfig.sourcePath,
        rootSource: null,
        configSearchSawProjectMarker,
        // Surface the loader's search root on
        // `warningsDetails.no_config_found.searchedFrom` so an agent
        // calling scan_file gets the same canonical "where was the
        // search?" answer scan / scan_project surface.
        configSearchedFromForWarning: configSearchBase,
        // Per-emission `findingId` path normalization: the scan root
        // here MUST agree with the root that `checklist` /
        // `scan_project` would use on the same canonical project
        // (typically the user-supplied `cwd`), so the same conceptual
        // candidate produces ONE id across surfaces. When the caller
        // omitted `cwd`, fall back to omitting `scanRoot` entirely
        // rather than substituting the file's parent directory — the
        // parent-dir fallback `configSearchBase` uses for config
        // resolution would relativize the path differently from the
        // project-root walk other surfaces use, re-introducing the
        // very cross-surface drift the closure fixes. Per
        // `docs/kb/architecture/ai-first-consumer.md` "Per-finding
        // identifiers must be addressable, not collision-prone" +
        // "Per-tool review-candidate shape must agree across
        // surfaces." Without `scanRoot`, the helper falls back to
        // path-shape normalization in place (backslashes → slashes,
        // `./` strip) — so absolute paths still produce stable ids
        // across machines.
        ...(scanFileCwd === undefined ? {} : { scanRoot: scanFileCwd }),
        // Thread the criterion-level lookup through to the
        // review-candidate dedup helper so per-candidate `priority`
        // resolves against the strongest-attention level among each
        // candidate's `criteria` union. Per
        // `docs/kb/architecture/ai-first-consumer.md` "Per-tool
        // review-candidate shape must agree across surfaces" — the
        // checklist surface populates priority/confidence on every
        // candidate; scan_file's deduped surface must match.
        criterionLevels: buildCriterionLevelMap(session.registry.standards),
      },
      { tokenBudget: 0, includeReviewCandidates: true },
    );

    // Cross-surface warning-channel parity: route through the shared
    // `buildScanTimeWarnings` helper so scan_file emits the same
    // scan-time warning code set + `meta.scannedBuildArtifacts`
    // classification that scan_project / coverage / checklist emit on
    // the identical input. Without this, an agent calling scan_file on
    // a `.min.css` got `findings: [...]` with no `scanned_minified_file`
    // / `scanned_build_artifacts_present` warning, while scan_project
    // on the same file flagged it as a build artifact — silent
    // cross-surface drift per `docs/kb/architecture/ai-first-consumer.md`
    // "Cross-surface count invariant" (warning-telemetry analogue).
    // The helper internally classifies build artifacts off the parsed
    // file source, so the predicate fires deterministically on the
    // single-file substrate. Discovery-only codes
    // (`text_source_skipped`, `binary_assets_skipped`, etc.) stay
    // omitted: they read off `analysisCoverage.skippedByExtension`,
    // which scan_file's single-file substrate never populates.
    const overlayed = applyCrossSurfaceWarnings({
      assembled,
      parsed,
      collected,
      configSource: projectConfig.sourcePath,
      configSearchSawProjectMarker,
      configSearchBase,
    });

    const fullResponse = buildScanFileResponse({
      assembled: overlayed,
      parsed,
      projectConfig,
      configSearchBase,
      scanFileCwd,
      params,
      session,
      activeRules: collected.activeRules,
    });
    // Q10-SCAN-FILE-NO-TRUNCATION-NO-OVERSIZE-PROTECTION: page the
    // findings list via `limit` / `offset`, then run the oversize-
    // envelope guard on the post-paging shape. Symmetric to the
    // scan_project token-density + slim-envelope chain — agents
    // calling scan_file on a dense single page (the canonical
    // motivating regression: 600+ findings on one component-library
    // entry-point) get a routable response instead of a host
    // transport drop. Per AI-first doctrine "Oversize-success is
    // ambiguous failure."
    const budgeted = applyScanFileBudget({
      limit: numParam(params, "limit"),
      offset: numParam(params, "offset"),
      maxBytes: numParam(params, "maxBytes"),
      response: fullResponse,
    });
    return textResult(budgeted.response);
  },
};

/**
 * Overlays the cross-surface scan-time warning channel onto an
 * already-assembled `scan_file` response, replacing the assembler-
 * computed `warnings` / `warningsDetails` with the canonical
 * {@link buildScanTimeWarnings} output and stamping
 * `meta.scannedBuildArtifacts` whenever the helper classified the
 * scanned file.
 *
 * Cross-surface invariant per
 * `docs/kb/architecture/ai-first-consumer.md` "Cross-surface count
 * invariant" (warning-telemetry analogue): the same scan basis
 * (parsed files + violations + config-resolution state) must produce
 * the same scan-time warning code set on every project-rooted MCP
 * tool consuming it. The assembler-internal `buildAssemblerWarningsField`
 * does NOT run the build-artifact classifier, so without this overlay
 * scan_file on `bootstrap.min.css` returns clean while scan_project
 * on the same file flags it as a build artifact + emits
 * `scanned_minified_file`.
 *
 * Discovery-only codes (`text_source_skipped`, `binary_assets_skipped`,
 * `sourcemap_files_excluded`, etc.) stay omitted because their
 * predicate reads off `analysisCoverage.skippedByExtension`, which
 * scan_file's single-file substrate never populates — single-file
 * scans don't run a discovery walk. The scoping is doctrine: a
 * surface that emits a code without the canonical payload is dishonest.
 */
function applyCrossSurfaceWarnings(args: {
  readonly assembled: ScanFamilyResponse;
  readonly parsed: ParsedFile;
  readonly collected: ScanCollected;
  readonly configSource: string | null;
  readonly configSearchSawProjectMarker: boolean;
  readonly configSearchBase: string;
}): ScanFamilyResponse {
  const {
    assembled,
    parsed,
    collected,
    configSource,
    configSearchSawProjectMarker,
    configSearchBase,
  } = args;
  const analysisCoverage = assembled.meta["analysisCoverage"] as
    | Record<string, unknown>
    | undefined;
  const filesByExtension =
    (assembled.meta["filesByExtension"] as Record<string, number> | undefined) ?? {};
  // Conjunction predicate for `scan_file_parser_bail_no_findings` —
  // populated only when scan_file's response will carry zero findings
  // AND the single scanned file took a parser-routing path known to
  // silently drop content (parse errors recorded against this file,
  // OR the dispatcher aliased a `.js` source through the in-house TSX
  // parser per `session.ts::parseForExtension`). The warning fires off
  // the conjunction-named predicate to disambiguate the dishonest
  // "Automated checks clean" framing the scan_file response otherwise
  // ships when the parser may have silenced findings rather than
  // observed a clean source — per AI-first doctrine "Zero-output
  // success is ambiguous failure." The scan_file call site is the
  // predicate authority because the project-shape `parser_bailed_zero_findings`
  // gate (across-files) cannot name the single-file routing-decision
  // case, and the routing-telemetry `parser_bailed_on_non_jsx_in_tsx_route`
  // alone does not name the zero-findings conjunction the agent reads
  // for triage.
  const scanFileParserBailNoFindings = deriveScanFileParserBailNoFindings(
    parsed,
    collected.violations.length === 0,
  );
  const scanTime = buildScanTimeWarnings({
    parsedFiles: [parsed],
    violations: collected.violations,
    root: configSearchBase,
    configSource,
    configSearchSawProjectMarker,
    rootSource: null,
    analysisCoverage,
    filesByExtension,
    durationMs: collected.durationMs,
    ...(scanFileParserBailNoFindings === undefined ? {} : { scanFileParserBailNoFindings }),
  });
  // Stamp `meta.scannedBuildArtifacts` from the helper's
  // single-pass classification so the field shows up on scan_file
  // exactly the way scan_project surfaces it. Conditional-spread per
  // CLAUDE.md §1 "Ambiguous field shapes are dishonest" — the field
  // is absent when the file did not classify as a build artifact.
  const nextMeta: Record<string, unknown> = {
    ...assembled.meta,
    ...scanTime.buildArtifactsMetaField,
  };
  // Cross-surface lane parity: route the assembled `plan` through
  // {@link withViolationsByScanKind} so `scan_file` on a vendor
  // stylesheet stamps `plan.violationsByScanKind: { source,
  // buildArtifact }` the same way `scan_project` on the identical
  // path does. Without this, an agent calling `scan_file` on
  // `bootstrap.min.css` got `plan.violationsByScanKind: undefined`
  // while `scan_project` on the same path classified the findings
  // under the buildArtifact lane — silent structural drift per
  // `docs/kb/architecture/ai-first-consumer.md` "Per-tool lane and
  // warning-set classification must agree." The classifier reuses
  // {@link collectBuildArtifacts} so the predicate matches the one
  // `scan_project` and the assembler-internal per-finding pass
  // already evaluate. Identity-stable when the file is not a build
  // artifact (vendor path set is empty; helper short-circuits and
  // returns the input plan unchanged).
  const buildArtifactPaths = new Set<string>(
    collectBuildArtifacts([parsed]).map((entry) => entry.path),
  );
  const planWithLane = withViolationsByScanKind(
    assembled.plan,
    assembled.files,
    buildArtifactPaths,
  );
  // Total replacement of the warnings channel: the shared helper is
  // a strict superset over the assembler-internal call (it folds in
  // build-artifact classification, scss-unresolved-variables,
  // bulk-catalog detection, etc.). Conditional-spread per the
  // present-when-meaningful contract — codes only appear when at least
  // one fired. Strip the keys from the rest of the spread so a stale
  // assembled value can't leak through.
  const {
    warnings: _droppedWarnings,
    warningsDetails: _droppedWarningsDetails,
    ...assembledWithoutWarnings
  } = assembled;
  return {
    ...assembledWithoutWarnings,
    plan: planWithLane,
    meta: nextMeta,
    ...(scanTime.warnings === undefined ? {} : { warnings: scanTime.warnings }),
    ...(scanTime.warningsDetails === undefined
      ? {}
      : { warningsDetails: scanTime.warningsDetails }),
  };
}

/**
 * Derives the `scan_file_parser_bail_no_findings` predicate input —
 * present-when-meaningful per AI-first "Ambiguous field shapes are
 * dishonest." Returns `undefined` when the scan_file response will
 * not be the routing-suspect-clean shape (findings exist, OR the
 * single scanned file shows neither parse errors nor a `.js → tsx`
 * routing-suspect alias).
 *
 * The two evidence axes are OR'd because either alone is sufficient
 * to mark the "Automated checks clean" framing dishonest:
 *
 *   - `parse_errors`: the parser recorded at least one `ParseError`
 *     against the AST (`parsed.ast.errors.length > 0`). The single-
 *     file analogue of the project-shape `parser_bailed_zero_findings`
 *     predicate — zero findings + parse errors = the parser silenced
 *     whatever rules would have run on the recovered slice. The
 *     existing `parse_errors_present` warning still fires alongside
 *     for the parse-error count payload; this code names the
 *     conjunction the per-file shape needs.
 *
 *   - `non_jsx_in_tsx_route`: the dispatcher aliased a `.js` source
 *     through the in-house TSX parser (per
 *     `src/mcp/session.ts::parseForExtension`). The TSX parser bails
 *     silently on relational expressions read as JSX (`r.length<b.length`)
 *     so a clean `ast.errors` list against a `.js` file is itself
 *     ambiguous evidence that no findings dropped. The existing
 *     `parser_bailed_on_non_jsx_in_tsx_route` warning names the
 *     routing decision regardless of outcome; this code names the
 *     zero-findings conjunction the agent reads for triage. Detected
 *     by the natural-vs-attempted parser mismatch
 *     (`naturalParserFor(filePath) !== ast.language` where the
 *     attempted parser is `tsx` and the natural parser is `js`).
 *
 * `naturalParser` is conditional-spread per the present-when-meaningful
 * contract — omitted when it would echo `parserAttempted`, surfaced
 * only when the dispatcher routed through a non-natural parser
 * (`.js` → tsx).
 */
function deriveScanFileParserBailNoFindings(
  parsed: ParsedFile,
  zeroFindings: boolean,
): WarningInputsForScanFile["scanFileParserBailNoFindings"] {
  if (!zeroFindings) return undefined;
  const errors = parsed.ast.errors;
  const hasParseError = errors.length > 0;
  const parserAttempted = parsed.ast.language;
  const natural = naturalParserFor(parsed.filePath);
  const isNonJsxInTsxRoute = parserAttempted === "tsx" && natural !== null && natural !== "tsx";
  if (!(hasParseError || isNonJsxInTsxRoute)) return undefined;
  // Parse-error evidence takes priority: when both axes hold (the
  // file is `.js`-routed-through-tsx AND the parser recorded errors),
  // the parse-error reason is the more specific signal — the agent
  // reads `analysisCoverage.parseErrorFiles[]` for the per-error fix
  // pivot rather than the broader routing-decision class.
  const evidence: "non_jsx_in_tsx_route" | "parse_errors" = hasParseError
    ? "parse_errors"
    : "non_jsx_in_tsx_route";
  const naturalParser = natural !== null && natural !== parserAttempted ? natural : undefined;
  return {
    filePath: parsed.filePath,
    parserAttempted,
    ...(naturalParser === undefined ? {} : { naturalParser }),
    evidence,
  };
}

/** Local type alias to keep the helper signature short. */
type WarningInputsForScanFile = Pick<WarningInputs, "scanFileParserBailNoFindings">;

/**
 * Structured error for a path that resolves outside its declared
 * `cwd`. Shared code (`path-escapes-cwd`) with `apply_fix` and
 * `suppress` so agents branch once on the escape-boundary failure
 * mode regardless of which tool detected it.-
 * CONTAINMENT — the asymmetry (suppress rejecting, scan_file
 * accepting) was the mental-model break the fix closes.
 */
function pathEscapesCwdResult(filePath: string, cwd: string): McpToolResult {
  return errorResult({
    code: "path-escapes-cwd",
    message: `path '${filePath}' escapes cwd '${cwd}'. Every scanned path must resolve inside the declared cwd.`,
    details: { file: filePath, cwd },
  });
}

/**
 * Structured error for a file path that does not exist on disk. Split
 * from the umbrella `file-unsupported` per Q-SHARED-SCAN-FILE-ERROR-
 * DISCRIMINATION so an agent can tell "the path you passed isn't
 * there" from "the extension isn't supported" from "the file exists
 * but couldn't be read" — three distinct recovery actions.
 */
function fileNotFoundResult(filePath: string): McpToolResult {
  return errorResult({
    code: "file-not-found",
    message: `File not found: ${filePath}`,
    details: { filePath },
    remediation: SCAN_FILE_NOT_FOUND_REMEDIATION,
  });
}

/**
 * Structured error for a file whose extension is not in
 * `PARSEABLE_EXTENSIONS`. Reached only after the path-exists pre-check
 * passes, so this is unambiguously the extension-filter branch — never
 * a missing file. Remediation enumerates the live parser registry so
 * it stays honest as the set grows.
 */
function unsupportedExtensionResult(filePath: string): McpToolResult {
  return errorResult({
    code: "file-unsupported",
    message: `Unsupported file extension: ${filePath}`,
    details: { filePath },
    remediation: SCAN_FILE_UNSUPPORTED_REMEDIATION,
  });
}

/**
 * Structured error for the exists-and-supported-but-unreadable case
 * (EACCES, encoding failures escaping `readFile`, symlink loops, etc.).
 * `details.cause` carries the underlying error message so the agent can
 * pick a recovery action without re-running the call under a debugger.
 */
function fileReadFailedResult(filePath: string, err: unknown): McpToolResult {
  const cause = err instanceof Error ? err.message : String(err);
  return errorResult({
    code: "file-read-failed",
    message: `Failed to read ${filePath}: ${cause}`,
    details: { filePath, cause },
    remediation: SCAN_FILE_READ_FAILED_REMEDIATION,
  });
}

/**
 * Assembles scan_file's historical flat-findings response body from
 * the assembled scan-family shape. Extracted from the handler so its
 * cognitive complexity stays under the lint cap; the conditional-
 * spread ergonomics + the next-step / meta overlay are the bulk of
 * the complexity.
 */
function buildScanFileResponse(args: {
  readonly assembled: ScanFamilyResponse;
  readonly parsed: ParsedFile;
  readonly projectConfig: LoadedConfig;
  readonly configSearchBase: string;
  readonly scanFileCwd: string | undefined;
  readonly params: Record<string, unknown>;
  readonly session: McpSession;
  readonly activeRules: readonly Rule[];
}): Record<string, unknown> {
  const {
    assembled,
    parsed,
    projectConfig,
    configSearchBase,
    scanFileCwd,
    params,
    session,
    activeRules,
  } = args;
  // scan_file's historical top-level shape is `{ findings,
  // reviewCandidates? }` rather than the grouped `files[]` the rest
  // of the scan family emits. Agents iterating the fix-verify loop
  // key off the flat `findings` array.
  const flatFindings = assembled.files[0]?.findings ?? [];
  // surface a top-level
  // `limitations` signal whenever the parser emitted errors on this
  // file. Without it, `fired: 0` + `warnings: [parse_errors_present]`
  // reads as "scan ran clean" at a glance — the degradation is only
  // visible after cross-reading `meta.analysisCoverage.parseErrorFiles`.
  // `partial_parse` vs `parse_error` comes from whether any rule
  // actually fired on the recovered slice (flatFindings.length > 0);
  // `detail` echoes the first parser-error message so the agent has
  // the fix pivot inline. Conditional-spread per CLAUDE.md §1
  // "Ambiguous field shapes are dishonest" — clean scans omit the
  // field entirely rather than ship `[]`.
  const limitation: FileLimitation | null = buildFileLimitation(parsed, flatFindings.length > 0);
  const nextStep = buildNextStep(
    {
      plan: assembled.plan,
      files: assembled.files,
      meta: assembled.meta,
      ...(assembled.referenceGuide === undefined
        ? {}
        : { referenceGuide: assembled.referenceGuide }),
      ...(assembled.ruleCoverage === undefined ? {} : { ruleCoverage: assembled.ruleCoverage }),
    },
    { singleFilePath: parsed.filePath },
  );
  const scannedEnvelope = scannedFile(parsed.filePath);
  // Single-file extension filter: scan_file knows the scanned file's
  // extension up front, so rules whose `appliesTo.fileExtensions` gate
  // doesn't intersect produced no signal AT ALL on this file. Reporting
  // them in `perRuleCoverage` (or `perRuleCoverageSummary.ruleIds`) with
  // a "no files matching .css were scanned" reason inflates the array
  // (~half the rows on a single-file scan) without telling the agent
  // anything actionable the simpler `rulesSkippedExtensionMismatch: N`
  // counter doesn't already carry. The shared
  // {@link filterPerRuleCoverageForSingleFile} helper handles the
  // alias-aware extension match (`.scss → .css`, `.md → .html`, etc.)
  // and returns the count of dropped rows. Project-scoped rules (no
  // extension gate) survive the filter unchanged. The
  // `rulesNotEvaluatedDueToInputType` field that the assembler emits
  // for multi-file scan-family tools is dropped on `scan_file` — the
  // single-file filter subsumes it with cleaner semantics; carrying
  // both would surface two counters with overlapping signal.
  const metaSpread = applySingleFileScopeFilterToMeta(
    applySingleFileExtensionFilterToMeta(assembled.meta, activeRules, parsed.filePath),
    parsed.filePath,
    configSearchBase,
  );
  const fullMeta: Record<string, unknown> = {
    ...metaSpread,
    filesScanned: 1,
    scanned: scannedEnvelope,
    configSource: projectConfig.sourcePath,
    //-
    // RECURRENCE: emit `configSearchedFrom` only when its value names
    // a directory the agent can't otherwise read off the response. The
    // shared {@link configSearchedFromField} helper widens the omit
    // predicate uniformly across every MCP surface: omit when the
    // value would echo (a) the caller-supplied `cwd`, (b) the
    // `scanned.root` of a project-mode scan, or (c) `dirname(scanned.file)`
    // of a file-mode scan. The Q6 closure used (a) only — `dirname`
    // matches kept slipping through on `scan_file` and on docs-site
    // fragment scans, so the helper folds (c) in too. `configNote`
    // (a 200-char boilerplate echoing the `no_config_found` warning
    // fired by the assembler when `configSource === null`) dropped
    // entirely per `.claude/rules/mcp-response-shapes.md`
    // "present-when-meaningful; never sentinel-empty."
    ...configSearchedFromField({
      searchBase: configSearchBase,
      callerCwd: scanFileCwd,
      scanned: scannedEnvelope,
    }),
    // `nextStep` and
    // `nextStepStructured` moved to the top level of the response.
    // One pointer, one place — the load-bearing agent-direction field
    // stays discoverable next to `plan` and `findings` rather than
    // buried inside scan-confidence telemetry.
  };
  return {
    findings: flatFindings,
    // Conditional-spread per CLAUDE.md §1 "Ambiguous field shapes are
    // dishonest": the assembler omits `reviewCandidates` when the
    // deduped set is empty (honest present-when-meaningful shape),
    // and we preserve that here rather than re-sentineling to `[]`.
    // The previous behavior shipped an empty array even on clean
    // scans, which forced the agent to re-disambiguate "empty vs
    // omitted" at every callsite.
    ...(assembled.reviewCandidates === undefined
      ? {}
      : { reviewCandidates: assembled.reviewCandidates }),
    // Cross-surface candidate-shape contract: per-criterion shared-
    // reason hoist. Same name + same shape as
    // `scan_project.reviewCandidatePrompts` /
    // `checklist.reviewCandidatePrompts` /
    // `review_candidates.prompts[criterionId].genericReason`. Per
    // `docs/kb/architecture/ai-first-consumer.md` "Per-tool review-
    // candidate shape must agree across surfaces" — the prompts axis
    // surfaces on every review-candidate-bearing tool. Conditional-
    // spread per CLAUDE.md §1 "Ambiguous field shapes are dishonest"
    // — assembler omits the field when the map is empty.
    ...(assembled.reviewCandidatePrompts === undefined
      ? {}
      : { reviewCandidatePrompts: assembled.reviewCandidatePrompts }),
    plan: assembled.plan,
    ...(limitation === null ? {} : { limitations: [limitation] }),
    ...(assembled.referenceGuide === undefined ? {} : { referenceGuide: assembled.referenceGuide }),
    ...(assembled.warnings === undefined ? {} : { warnings: assembled.warnings }),
    ...(assembled.warningsDetails === undefined
      ? {}
      : { warningsDetails: assembled.warningsDetails }),
    // top-level agent direction.
    // structured twin — conditional-spread per CLAUDE.md §1
    // "Ambiguous field shapes are dishonest" so the fallback multi-
    // option prose doesn't ship a sentinel machine hint.
    nextStep: nextStep.prose,
    ...(nextStep.structured === undefined ? {} : { nextStepStructured: nextStep.structured }),
    meta: applyMetaCacheMode({ toolName: "scan_file", params, fullMeta, session }),
  };
}

/**
 * Filters the assembler-built `meta` block down to the single-file
 * scope by dropping per-rule rows whose `appliesTo.fileExtensions`
 * gate doesn't match the scanned file's extension. Returns a fresh
 * object keyed for spread into `fullMeta`.
 *
 * Three meta keys are touched:
 *
 *   - `perRuleCoverage` (verbose mode): replaced with the filter's
 *     `retained` array. Omitted entirely when `retained` is empty
 *     so the assembler's existing conditional-spread shape stays
 *     intact.
 *   - `perRuleCoverageSummary` (default mode): `ruleIds` narrowed
 *     to the IDs of `retained`; `ruleCount` updated. Omitted when
 *     `retained` is empty.
 *   - `rulesNotEvaluatedDueToInputType`: dropped — the `scan_file`
 *     surface uses the cleaner `rulesSkippedExtensionMismatch`
 *     counter instead. Carrying both would surface two counters
 *     with overlapping signal on the single-file shape.
 *
 * Adds `rulesSkippedExtensionMismatch: N` (always present, including
 * zero — scan-confidence telemetry per the always-present-on-zero
 * rule for fields the agent branches on).
 *
 * Other meta keys pass through unchanged.
 */
function applySingleFileExtensionFilterToMeta(
  meta: Record<string, unknown>,
  activeRules: readonly Rule[],
  filePath: string,
): Record<string, unknown> {
  const ext = fileExtension(filePath);
  const verboseRows = meta["perRuleCoverage"] as readonly PerRuleCoverage[] | undefined;
  const summary = meta["perRuleCoverageSummary"] as
    | { readonly ruleCount: number; readonly ruleIds: readonly string[] }
    | undefined;
  // The shared assembler routes rows through `partitionPerRuleCoverage`
  // before they reach this seam — that partition collapses
  // extension-gated rows whose runner-tracker tally hit zero into a
  // sibling `rulesNotEvaluatedDueToInputType: { count, byExtension }`
  // counter. On `scan_file`'s single-file substrate the partition's
  // predicate (`filesEvaluated === 0 && filesEligible === 0` AND
  // extension-gated) is functionally equivalent to this seam's static
  // extension match, so the bulk of the count flows in via that
  // partition. Re-running the static filter here catches the rare
  // residual case where the runner-tracker reported `eligible > 0`
  // for an extension-mismatched rule (defensive — should not occur,
  // but the agent reads `rulesSkippedExtensionMismatch` as an
  // honest total either way) and folds the partition count in.
  const partitionCount = readPartitionCount(meta["rulesNotEvaluatedDueToInputType"]);
  // Source rows: prefer the verbose array when present; otherwise
  // synthesize a placeholder array from the summary's rule IDs by
  // looking up each ID in `activeRules`. Default-verbosity scans only
  // ship the summary, so the filter operates on the rule-ID list and
  // re-narrows the `ruleIds` field below.
  let filtered: PerRuleCoverage[] | undefined;
  let extraSkipped = 0;
  if (verboseRows !== undefined) {
    const result = filterPerRuleCoverageForSingleFile(verboseRows, activeRules, ext);
    filtered = [...result.retained];
    extraSkipped = result.skippedExtensionMismatch;
  } else if (summary !== undefined) {
    // Synthesize minimal rows from the summary's rule IDs so the
    // shared filter applies its alias-aware extension match without
    // duplicating logic at this seam. The synthesized fields are
    // placeholders — only `ruleId` is consumed by the filter — and the
    // re-emit below uses just `retained.map(r => r.ruleId)`.
    const synthetic: PerRuleCoverage[] = summary.ruleIds.map((ruleId) => ({
      ruleId,
      filesEvaluated: 0,
      filesEligible: 0,
      findingsEmitted: 0,
      // Synthesized placeholder — `fired` is structurally `false` here;
      // the filter only consumes `ruleId` and the re-emit below carries
      // only the rule-ID list, but the type contract on PerRuleCoverage
      // requires the field be populated.
      fired: false,
      coverageConfidence: "low" as const,
    }));
    const result = filterPerRuleCoverageForSingleFile(synthetic, activeRules, ext);
    filtered = [...result.retained];
    extraSkipped = result.skippedExtensionMismatch;
  }
  const skippedExtensionMismatch = partitionCount + extraSkipped;
  // Build the new meta. Drop `rulesNotEvaluatedDueToInputType` so the
  // single-file response carries one canonical counter
  // (`rulesSkippedExtensionMismatch`) for the same conceptual signal.
  // Two counters with overlapping signal force the agent to
  // disambiguate which is canonical and risk silent drift.
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (key === "perRuleCoverage" || key === "perRuleCoverageSummary") continue;
    if (key === "rulesNotEvaluatedDueToInputType") continue;
    out[key] = value;
  }
  if (filtered !== undefined && filtered.length > 0) {
    if (verboseRows === undefined) {
      out["perRuleCoverageSummary"] = {
        ruleCount: filtered.length,
        ruleIds: filtered.map((r) => r.ruleId).sort(),
      };
    } else {
      out["perRuleCoverage"] = filtered;
    }
  }
  out["rulesSkippedExtensionMismatch"] = skippedExtensionMismatch;
  return out;
}

/**
 * Reads the count out of the assembler's
 * `meta.rulesNotEvaluatedDueToInputType` field. The shared
 * `RulesNotEvaluatedDueToInputType` shape is
 * `{ count: number, byExtension: Record<string, number>,
 *    ruleIds: readonly string[] }` and rides unconditionally — but at
 * this seam the field arrives as `unknown` (the meta block is keyed by
 * string, value `unknown`), so the read is defensive against a future
 * shape change. Returns 0 on any shape mismatch — honest fallback (the
 * static filter still catches its share) rather than throwing in an
 * MCP request handler.
 */
function readPartitionCount(value: unknown): number {
  if (typeof value !== "object" || value === null) return 0;
  const count = (value as { readonly count?: unknown }).count;
  return typeof count === "number" ? count : 0;
}

/**
 * Defensive per-file scope filter — guarantees the assembled meta block
 * contains only evidence about the single scanned file. Walks every
 * known path-keyed sub-array on `meta.analysisCoverage` (parse-error
 * buckets, fragment files, frontmatter / php / erb / astro evidence
 * lists, default-excluded-artifact entries, sourcemap files) plus
 * `meta.scannedBuildArtifacts.{grouped, classified}` and drops any
 * entry whose `path` does not equal `scannedFilePath`.
 *
 * Most of the time this is a no-op: the analysis-coverage accumulator
 * walks `[parsed]` only on the scan_file path so per-file and
 * cross-file evidence are already aligned. The filter is a defensive
 * guard against any future regression where a project-shaped
 * accumulator state (build-artifact classifier carry-over, prior-scan
 * cache, cross-file resolution) silently leaks into a per-file
 * response. Per the AI-first doctrine "Per-tool lane and warning-set
 * classification must agree" extended downward: a per-file response
 * must carry only per-file evidence; an entry mentioning a sibling
 * file forces the agent to re-read and disambiguate whether that
 * file was actually involved in evaluating the scanned one.
 *
 * The filter mutates a fresh shallow copy of the input; the original
 * `meta` object is left untouched so any reference held by the
 * caller's earlier slot (e.g. the assembler's internal cache) stays
 * intact. Companion count fields (`parseErrorFileCount`,
 * `partialParseFileCount`, `fragmentFileCount`) are recomputed off
 * the filtered list lengths so they reconcile with the array sizes;
 * empty buckets are dropped entirely (present-when-meaningful per
 * CLAUDE.md §1) so the response shape stays honest.
 */
export function applySingleFileScopeFilterToMeta(
  meta: Record<string, unknown>,
  scannedFilePath: string,
  configSearchBase?: string,
): Record<string, unknown> {
  const acceptablePaths = collectAcceptablePathForms(scannedFilePath, configSearchBase);
  const out: Record<string, unknown> = { ...meta };
  const coverage = out["analysisCoverage"];
  if (typeof coverage === "object" && coverage !== null) {
    out["analysisCoverage"] = filterAnalysisCoverageToScannedFile(
      coverage as Record<string, unknown>,
      acceptablePaths,
    );
  }
  const buildArtifacts = out["scannedBuildArtifacts"];
  if (typeof buildArtifacts === "object" && buildArtifacts !== null) {
    const filtered = filterScannedBuildArtifactsToScannedFile(
      buildArtifacts as Record<string, unknown>,
      acceptablePaths,
    );
    if (filtered === undefined) {
      delete out["scannedBuildArtifacts"];
    } else {
      out["scannedBuildArtifacts"] = filtered;
    }
  }
  return out;
}

/**
 * Builds the set of path forms that are equivalent to the scanned
 * file. Different sub-systems on the meta block may store the scanned
 * file's path in different normalizations:
 *
 *   - the analysis-coverage accumulator records `file.filePath`
 *     verbatim (the user-supplied path), so the entry-shaped
 *     parse-error / fragment / php / erb buckets match by exact
 *     equality.
 *   - `meta.scannedBuildArtifacts.classified[]` carries paths
 *     relativized against the scan root (configSearchBase), so the
 *     filter must also accept that form.
 *
 * Producing the union once at the top of the filter keeps each
 * sub-array filter a simple `Set.has()` check — predicate match
 * stays O(1) per entry and the path-shape variance is centralized.
 */
function collectAcceptablePathForms(
  scannedFilePath: string,
  configSearchBase: string | undefined,
): ReadonlySet<string> {
  const out = new Set<string>();
  out.add(scannedFilePath);
  // POSIX-normalized form so `\\`-separated Windows paths align with
  // the relativized POSIX entries downstream.
  const posix = scannedFilePath.replace(/\\/g, "/");
  out.add(posix);
  if (configSearchBase !== undefined) {
    const rootPosix = configSearchBase.replace(/\\/g, "/");
    const rootTrimmed = rootPosix.endsWith("/") ? rootPosix.slice(0, -1) : rootPosix;
    if (posix.startsWith(`${rootTrimmed}/`)) {
      const rel = posix.slice(rootTrimmed.length + 1);
      if (rel.length > 0 && !rel.startsWith("../")) out.add(rel);
    }
  }
  return out;
}

/**
 * Per-file scope filter for `meta.analysisCoverage`. Drops every
 * entry whose `path` (entry-shaped) or string element (string-list-
 * shaped) does not equal `scannedFilePath`, then re-emits the
 * surviving entries with companion count fields recomputed and
 * empty buckets omitted entirely.
 */
function filterAnalysisCoverageToScannedFile(
  coverage: Record<string, unknown>,
  acceptablePaths: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...coverage };
  // Entry-shaped path-keyed arrays — `{ path, ... }`.
  filterEntryListField(out, "parseErrorFiles", acceptablePaths, "parseErrorFileCount");
  filterEntryListField(out, "partialParseFiles", acceptablePaths, "partialParseFileCount");
  filterEntryListField(out, "fragmentFiles", acceptablePaths, "fragmentFileCount");
  filterEntryListField(out, "defaultExcludedArtifactPaths", acceptablePaths);
  // String-list path-keyed arrays — `string[]`.
  filterStringListField(out, "phpIslandsStrippedFiles", acceptablePaths);
  filterStringListField(out, "erbIslandsUnrenderedFiles", acceptablePaths);
  filterStringListField(out, "astroIslandsUnrenderedFiles", acceptablePaths);
  filterStringListField(out, "frontmatterFenceFiles", acceptablePaths);
  filterStringListField(out, "sourcemapFiles", acceptablePaths);
  return out;
}

/**
 * Filters an entry-shaped list field on a coverage block down to
 * entries whose `path` equals `scannedFilePath`. Drops the field
 * entirely when nothing survives so the wire shape stays
 * present-when-meaningful. Optionally rewrites a companion count
 * scalar so it reconciles with the filtered array length; the
 * count is also dropped on empty so an absent array never ships
 * alongside a `0` scalar twin.
 */
function filterEntryListField(
  coverage: Record<string, unknown>,
  listKey: string,
  acceptablePaths: ReadonlySet<string>,
  countKey?: string,
): void {
  const value = coverage[listKey];
  if (!Array.isArray(value)) return;
  const retained = value.filter(
    (entry): entry is { readonly path: string } =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { readonly path?: unknown }).path === "string" &&
      acceptablePaths.has((entry as { readonly path: string }).path),
  );
  if (retained.length === 0) {
    delete coverage[listKey];
    if (countKey !== undefined) delete coverage[countKey];
    return;
  }
  if (retained.length === value.length) return;
  coverage[listKey] = retained;
  if (countKey !== undefined) coverage[countKey] = retained.length;
}

/**
 * Filters a string-list path-keyed field on a coverage block down
 * to entries equal to `scannedFilePath`. Drops the field entirely
 * when nothing survives so the wire shape stays
 * present-when-meaningful.
 */
function filterStringListField(
  coverage: Record<string, unknown>,
  listKey: string,
  acceptablePaths: ReadonlySet<string>,
): void {
  const value = coverage[listKey];
  if (!Array.isArray(value)) return;
  const retained = value.filter(
    (entry): entry is string => typeof entry === "string" && acceptablePaths.has(entry),
  );
  if (retained.length === 0) {
    delete coverage[listKey];
    return;
  }
  if (retained.length === value.length) return;
  coverage[listKey] = retained;
}

/**
 * Per-file scope filter for `meta.scannedBuildArtifacts`. Drops
 * every `classified[]` entry whose `path` does not equal
 * `scannedFilePath`. Grouped rows aggregate same-basename clusters
 * across the corpus — on a per-file response a grouped row could
 * only honestly represent a single file (count 1), which is the
 * sub-threshold case the grouper would ship under `classified[]`
 * anyway, so any grouped rows that survive on a single-file scan
 * are already a sign of cross-file leak; drop them.
 *
 * Returns `undefined` when both the filtered `classified[]` and
 * `grouped[]` arrays are empty — the caller drops the whole
 * `scannedBuildArtifacts` field so an empty container doesn't ride
 * alongside a populated peer.
 */
function filterScannedBuildArtifactsToScannedFile(
  buildArtifacts: Record<string, unknown>,
  acceptablePaths: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  const classifiedRaw = buildArtifacts["classified"];
  const classified = Array.isArray(classifiedRaw)
    ? classifiedRaw.filter(
        (entry): entry is { readonly path: string } =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as { readonly path?: unknown }).path === "string" &&
          acceptablePaths.has((entry as { readonly path: string }).path),
      )
    : [];
  // Grouped rows aggregate same-basename clusters of >=3 paths; on
  // a single-file scan no honest grouped row can survive. Treat any
  // surviving grouped[] entries as cross-file leakage and drop them.
  const grouped: readonly unknown[] = [];
  if (classified.length === 0 && grouped.length === 0) return undefined;
  const out: Record<string, unknown> = { ...buildArtifacts, grouped, classified };
  // `classifiedTruncated` describes the pre-cap classified[]
  // length on bulk-corpus scans; on a per-file scope it can never
  // honestly fire, so drop the sentinel if present so the agent
  // doesn't read a truncation tag against a one-entry list.
  if ("classifiedTruncated" in out) delete out["classifiedTruncated"];
  return out;
}
