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
 * `configSource`, `configSearchedFrom`, `configNote`, `nextStep`).
 */

import { isAbsolute, resolve } from "node:path";
import type { ParsedFile } from "../engine/scanner.ts";
import type { LoadedConfig } from "../types/config.ts";
import { parseableExtensions } from "../utils/path.ts";
import { applyMetaCacheMode, metaModeSchema } from "./meta-cache.ts";
import { buildNextStep } from "./next-step.ts";
import { pathExists } from "./path-exists.ts";
import { assembleScanFamilyResponse, type ScanFamilyResponse } from "./response-assembler.ts";
import { runScanAndCollect } from "./scan-collect.ts";
import { scannedFile } from "./scanned-envelope.ts";
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
// hardcoded list at the two early-exit sites below.
const SCAN_FILE_UNSUPPORTED_REMEDIATION = `Pass a file with one of these extensions that exists on disk: ${parseableExtensions().join(", ")}.`;

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
            "When true, the response includes an `analysisCoverage` block with parse-error and opaque-component details, plus `rulesByExtension` so you can verify which rules ran on this file's type. Off by default.",
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

    // Pre-check existence so a missing file produces the same tool-level
    // error envelope as an unsupported extension, instead of ENOENT
    // escaping `parseFile` and degrading to a JSON-RPC protocol error
    // that the caller can't `isError`-branch on like the other tools.
    const scanFileCwd = strParam(params, "cwd");
    if (!(await pathExists(filePath, scanFileCwd))) {
      return unsupportedResult(filePath);
    }

    const parsed = await session.parseFile(filePath, scanFileCwd);
    if (!parsed) return unsupportedResult(filePath);

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
      },
      { tokenBudget: 0, includeReviewCandidates: true },
    );

    return textResult(
      buildScanFileResponse({
        assembled,
        parsed,
        projectConfig,
        configSearchBase,
        params,
        session,
      }),
    );
  },
};

/** Structured error for the file-not-found / unsupported-extension branches. */
function unsupportedResult(filePath: string): McpToolResult {
  return errorResult({
    code: "file-unsupported",
    message: `Unsupported or unreadable file: ${filePath}`,
    details: { filePath },
    remediation: SCAN_FILE_UNSUPPORTED_REMEDIATION,
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
  readonly params: Record<string, unknown>;
  readonly session: McpSession;
}): Record<string, unknown> {
  const { assembled, parsed, projectConfig, configSearchBase, params, session } = args;
  // scan_file's historical top-level shape is `{ findings,
  // reviewCandidates? }` rather than the grouped `files[]` the rest
  // of the scan family emits. Agents iterating the fix-verify loop
  // key off the flat `findings` array.
  const flatFindings = assembled.files[0]?.findings ?? [];
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
  const fullMeta: Record<string, unknown> = {
    ...assembled.meta,
    filesScanned: 1,
    scanned: scannedFile(parsed.filePath),
    configSource: projectConfig.sourcePath,
    configSearchedFrom: configSearchBase,
    ...(projectConfig.sourcePath === null
      ? {
          configNote: `No ra11y.config found walking up from ${configSearchBase} — using built-in defaults (no nativeWrappers, no per-rule overrides). Drop a ra11y.config.ts at the project root to register design-system wrappers and customize severities.`,
        }
      : {}),
    nextStep: nextStep.prose,
    // P1-K: structured twin of the prose nextStep. Conditional-spread
    // per CLAUDE.md §1 "Ambiguous field shapes are dishonest": omit
    // `nextStepStructured` when the prose falls back to generic
    // advice rather than ship a sentinel value.
    ...(nextStep.structured === undefined ? {} : { nextStepStructured: nextStep.structured }),
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
    ...(assembled.referenceGuide === undefined ? {} : { referenceGuide: assembled.referenceGuide }),
    ...(assembled.warnings === undefined ? {} : { warnings: assembled.warnings }),
    ...(assembled.warningsDetails === undefined
      ? {}
      : { warningsDetails: assembled.warningsDetails }),
    meta: applyMetaCacheMode({ toolName: "scan_file", params, fullMeta, session }),
  };
}
