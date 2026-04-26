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
 * {@link assembleScanFamilyResponse} per V1-RESPONSE-SCAN-CORE — the
 * handler owns only the tool-specific shape adaptation (flatten
 * `files[0].findings`) and the outer fields (`scanned`,
 * `configSource`, `configSearchedFrom`, `nextStep`).
 */

import { isAbsolute, resolve } from "node:path";
import type { ParsedFile } from "../engine/scanner.ts";
import type { LoadedConfig } from "../types/config.ts";
import { parseableExtensions } from "../utils/path.ts";
import { sawProjectMarkerInWalk } from "./config-search-marker.ts";
import { buildFileLimitation, type FileLimitation } from "./file-limitations.ts";
import { applyMetaCacheMode, metaModeSchema } from "./meta-cache.ts";
import { buildNextStep } from "./next-step.ts";
import { pathExists } from "./path-exists.ts";
import { resolveInsideCwd } from "./resolve-inside-cwd.ts";
import { assembleScanFamilyResponse, type ScanFamilyResponse } from "./response-assembler.ts";
import { runScanAndCollect } from "./scan-collect.ts";
import { scannedFile } from "./scanned-envelope.ts";
import { configSearchedFromField } from "./scanner-meta.ts";
import type { McpSession } from "./session.ts";
import {
  errorResult,
  type McpTool,
  type McpToolResult,
  resolveStandards,
  strParam,
  textResult,
} from "./tools-helpers.ts";
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
            "When true, the response includes the full `meta.perRuleCoverage[]` array (per-rule coverage rows with concentration / parse-error confidence reasons; at default verbosity replaced by `perRuleCoverageSummary: { ruleCount, ruleIds }`) plus the `analysisCoverage` block with parse-error and opaque-component details, plus `rulesFiredByExtension` (legacy alias `rulesByExtension` ships alongside for one minor release per ADR 0028) so you can verify which rules were eligible to run on this file's type. The scan-confidence telemetry (`rulesEvaluated`, `rulesNotEvaluatedDueToInputType`) stays inline at every verbosity. Off by default to keep per-file responses bounded on dense HTML; enable when triaging which rules ran on this file.",
        },
        metaMode: metaModeSchema,
      },
      required: ["path"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async handler(params, session) {
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
    // V1-SCAN-FILE-CWD-CONTAINMENT: reject paths that escape the
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
      },
      { tokenBudget: 0, includeReviewCandidates: true },
    );

    return textResult(
      buildScanFileResponse({
        assembled,
        parsed,
        projectConfig,
        configSearchBase,
        scanFileCwd,
        params,
        session,
      }),
    );
  },
};

/**
 * Structured error for a path that resolves outside its declared
 * `cwd`. Shared code (`path-escapes-cwd`) with `apply_fix` and
 * `suppress` so agents branch once on the escape-boundary failure
 * mode regardless of which tool detected it. V1-SCAN-FILE-CWD-
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
}): Record<string, unknown> {
  const { assembled, parsed, projectConfig, configSearchBase, scanFileCwd, params, session } = args;
  // scan_file's historical top-level shape is `{ findings,
  // reviewCandidates? }` rather than the grouped `files[]` the rest
  // of the scan family emits. Agents iterating the fix-verify loop
  // key off the flat `findings` array.
  const flatFindings = assembled.files[0]?.findings ?? [];
  // Q4-SCAN-FILE-PARSE-ERROR-LIMITATIONS-FIELD: surface a top-level
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
  const fullMeta: Record<string, unknown> = {
    ...assembled.meta,
    filesScanned: 1,
    scanned: scannedEnvelope,
    configSource: projectConfig.sourcePath,
    // Q6-CONFIG-CONTEXT-TRIPLE-READOUT + Q8-CONFIGSEARCHEDFROM-ECHO-
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
    // V1-NEXTSTEP-DEDUP-META-VS-TOP-LEVEL: `nextStep` and
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
    plan: assembled.plan,
    ...(limitation === null ? {} : { limitations: [limitation] }),
    ...(assembled.referenceGuide === undefined ? {} : { referenceGuide: assembled.referenceGuide }),
    ...(assembled.warnings === undefined ? {} : { warnings: assembled.warnings }),
    ...(assembled.warningsDetails === undefined
      ? {}
      : { warningsDetails: assembled.warningsDetails }),
    // V1-NEXTSTEP-DEDUP-META-VS-TOP-LEVEL: top-level agent direction.
    // P1-K: structured twin — conditional-spread per CLAUDE.md §1
    // "Ambiguous field shapes are dishonest" so the fallback multi-
    // option prose doesn't ship a sentinel machine hint.
    nextStep: nextStep.prose,
    ...(nextStep.structured === undefined ? {} : { nextStepStructured: nextStep.structured }),
    meta: applyMetaCacheMode({ toolName: "scan_file", params, fullMeta, session }),
  };
}
