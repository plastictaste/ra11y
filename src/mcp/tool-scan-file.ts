/**
 * The `scan_file` MCP tool. Scans a single file with cached ASTs so the
 * fix-verify loop (edit → re-scan) stays fast. Lives in its own file so
 * `src/mcp/tools.ts` stays focused on tool schemas and inventory.
 *
 * Response shape is the historical flat-findings form:
 * `{ findings, reviewCandidates, plan, referenceGuide?, warnings?,
 * warningsDetails?, meta }`. Agents iterating the fix-verify loop key
 * off the flat `findings` array rather than the grouped `files[]` that
 * the rest of the scan family emits. `plan` and `meta` still ride
 * along so the envelope stays honest about counts and scan-confidence
 * telemetry.
 */

import { isAbsolute, resolve } from "node:path";
import { parseableExtensions } from "../utils/path.ts";
import { applyMetaCacheMode, metaModeSchema } from "./meta-cache.ts";
import { buildNextStep } from "./next-step.ts";
import { pathExists } from "./path-exists.ts";
import { hoistAndBuildReferenceGuide } from "./reference-guide.ts";
import { dedupeReviewCandidatesForSingleFile } from "./review-candidate-dedup.ts";
import { scannedFile } from "./scanned-envelope.ts";
import {
  errorResult,
  type McpTool,
  resolveStandards,
  runScanAndFormat,
  strParam,
  textResult,
} from "./tools-helpers.ts";
import { warningsFieldFromScanMeta } from "./warnings.ts";
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
      return errorResult({
        code: "file-unsupported",
        message: `Unsupported or unreadable file: ${filePath}`,
        details: { filePath },
        remediation: SCAN_FILE_UNSUPPORTED_REMEDIATION,
      });
    }

    const parsed = await session.parseFile(filePath, scanFileCwd);
    if (!parsed) {
      return errorResult({
        code: "file-unsupported",
        message: `Unsupported or unreadable file: ${filePath}`,
        details: { filePath },
        remediation: SCAN_FILE_UNSUPPORTED_REMEDIATION,
      });
    }

    // Resolve the directory to search for ra11y.config.* and to feed
    // runScanAndFormat. Mirrors scan_project's precedence: explicit
    // cwd wins; otherwise we walk up from the file's own directory so
    // the loader can still find a project config when the agent
    // didn't pass cwd.
    const absFilePath = isAbsolute(filePath)
      ? filePath
      : resolve(scanFileCwd ?? process.cwd(), filePath);
    const configSearchBase =
      scanFileCwd ?? (absFilePath.slice(0, absFilePath.lastIndexOf("/")) || process.cwd());
    const projectConfig = await session.loadProjectConfig(configSearchBase);
    const standards = resolveStandards(strParam(params, "standard"), session);

    // Reuse runScanAndFormat so the `meta` envelope matches scan_project
    // verbatim (rulesEvaluated, filesByExtension, activeNativeWrappers,
    // analysisCoverage, suppressions, standards, durationMs). Without
    // this, scan_file's fix-verify loop couldn't confirm config parity
    // with the scan_project call that kicked off the work — the
    // canonical Track Q shape-drift bug.
    const { formatted, reviewCandidates: rawCandidates } = await runScanAndFormat(
      [parsed],
      session,
      standards,
      strParam(params, "minSeverity"),
      session.effectiveRules(projectConfig),
      buildWrapperSourcesFromConfig(projectConfig, session),
      configSearchBase,
      params["verboseMeta"] === true,
    );

    // scan_file's historical top-level shape is `{ findings, reviewCandidates }`
    // rather than scan_project's `{ plan, files[], meta }`. Preserve
    // that — agents iterating the fix-verify loop key off the flat
    // `findings` array. `plan` and `meta` still ride along so the
    // envelope is honest about counts and scan-confidence telemetry.
    //
    // V1-SIZE-RESPONSE-BUDGET-DENSITY option (b): hoist duplicated
    // `fix.description` prose. Single-file scans rarely cross the
    // ≥2-duplicate threshold, but `semantics/label-in-name` on a file
    // with many interactive elements can — the hoist fires only when
    // duplicates exist, else findings pass through unchanged.
    const hoisted = hoistAndBuildReferenceGuide(formatted.files, formatted.referenceGuide);
    const flatFindings = hoisted.files[0]?.findings ?? [];
    const nextStep = buildNextStep(formatted, { singleFilePath: parsed.filePath });
    // P1-K: structured twin of the prose nextStep. Conditional-spread
    // per CLAUDE.md §1 "Ambiguous field shapes are dishonest": omit
    // `nextStepStructured` when the prose falls back to generic
    // advice, rather than ship a sentinel value.
    const nextStepStructuredField =
      nextStep.structured === undefined ? {} : { nextStepStructured: nextStep.structured };
    // Cross-standard dedup mirrors the violation-level collapse the
    // rule runner already performs (one Violation with
    // `criteria: string[]` across every enabled standard). Finders emit
    // one candidate per criterion — without this collapse the same
    // line appears 4-6x in the response. scan_file scans a single file,
    // so rawCandidates is already scoped to that file — no per-path
    // filter needed.
    const dedupedCandidates = dedupeReviewCandidatesForSingleFile(rawCandidates);

    const fullMeta: Record<string, unknown> = {
      ...formatted.meta,
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
      ...nextStepStructuredField,
    };
    return textResult({
      findings: flatFindings,
      reviewCandidates: dedupedCandidates,
      plan: formatted.plan,
      ...(hoisted.referenceGuide === undefined ? {} : { referenceGuide: hoisted.referenceGuide }),
      ...warningsFieldFromScanMeta({
        meta: formatted.meta,
        // scan_file has no project-root / `rootSource` concept — the
        // file IS the scope. Passing null here suppresses the
        // `root_source_defaulted` warning, which is a scan_project-only
        // signal.
        rootSource: null,
        configSource: projectConfig.sourcePath,
      }),
      meta: applyMetaCacheMode({ toolName: "scan_file", params, fullMeta, session }),
    });
  },
};
