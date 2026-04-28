/**
 * The `scan` MCP tool. Scans file or directory paths passed explicitly
 * by the caller, without a project-root resolution step. Lives in its
 * own file so `src/mcp/tools.ts` stays focused on tool schemas and
 * inventory.
 *
 * Response shape is scan-family: `{ plan, files, meta, warnings?,
 * warningsDetails?, referenceGuide?, ruleCoverage?, truncated?,
 * totalFilesWithFindings? }`. Assembly routes through
 * {@link assembleScanFamilyResponse} per — the
 * handler owns only the tool-specific outer fields (`scanned`,
 * `configSource`, `nextStep`) and
 * the scan-specific token-density merge (no `nextOffset`, because
 * `scan` has no resumable paging primitive; the remediation is to
 * narrow `paths` or switch to `scan_project`).
 */

import { sawProjectMarkerInWalk } from "./config-search-marker.ts";
import { probeExtensionsPresentAtRoot } from "./extension-subkind.ts";
import { applyMetaCacheMode, metaModeSchema } from "./meta-cache.ts";
import { buildNextStep } from "./next-step.ts";
import { pathExists } from "./path-exists.ts";
import { assembleScanFamilyResponse } from "./response-assembler.ts";
import { includeRuleDetailsSchema, ruleCatalogField } from "./rule-catalog.ts";
import { mergeScanTokenBudget } from "./scan-budget.ts";
import { runScanAndCollect } from "./scan-collect.ts";
import { scannedDir } from "./scanned-envelope.ts";
import { applyTokenBudget } from "./token-budget.ts";
import {
  errorResult,
  type McpTool,
  parseFiles,
  resolveStandards,
  strArrayParam,
  strParam,
  textResult,
} from "./tools-helpers.ts";
import { warningsField } from "./warnings.ts";
import { buildWrapperSourcesFromConfig } from "./wrappers-meta.ts";

export const scanTool: McpTool = {
  def: {
    name: "scan",
    description:
      "Scan files or directories for accessibility violations. Returns findings grouped by file with fix suggestions. Start here to find issues. Keep the default minSeverity: 'info' — info findings are high-value signals the tool can't verify alone (PascalCase component wrappers, cross-file CSS/JSX, etc.) and are exactly what you can resolve by reading the code.",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description:
            "File or directory paths to scan. A single array may mix files and directories — each entry is resolved individually before scanning.",
        },
        standard: {
          type: "string",
          description: "Standard ID (e.g. wcag22, wcag21). Defaults to session config.",
        },
        level: {
          type: "string",
          enum: ["A", "AA", "AAA"],
          description: "Conformance level. Defaults to session config.",
        },
        minSeverity: {
          type: "string",
          enum: ["error", "warning", "info"],
          description:
            "Minimum severity to include. Default is 'info' and you should keep it — info findings are low-confidence cases where static analysis can't resolve a component boundary or cross-file reference, but you CAN by reading the source. Skipping them ships false negatives on real issues. Only raise to 'warning' for CI gates where no human is in the loop.",
        },
        cwd: {
          type: "string",
          description:
            "Base directory for resolving relative paths. Pass your current working directory (e.g. a git worktree) to avoid picking up the server's spawn-time cwd.",
        },
        verboseMeta: {
          type: "boolean",
          description:
            "When true, the meta block expands its compact summaries into the underlying per-row payloads. Affects: `perRuleCoverage[]` (full per-rule coverage rows — at default verbosity replaced by `perRuleCoverageSummary: { ruleCount, ruleIds }`) and analysisCoverage's `opaqueCustomComponentNames` + `rulesEligibleByExtension`. `parseErrorFiles` (paths that errored AND produced zero findings; invisible to rules) and `partialParseFiles` (errored + still produced findings) always ship with `{ path, parserAttempted, naturalParser?, reason }` entries regardless of this flag — `parserAttempted` names the parser actually invoked (the routing decision); `naturalParser` is present-when-meaningful, surfaced only when the dispatcher routed the file through a non-natural parser (`.js` → tsx, `.svg` → html); the parser + reason pair is the fix pivot. The scan-confidence telemetry (`configSource`, `activeNativeWrappers`, `rulesEvaluated`, `filesByExtension`, `rulesNotEvaluatedDueToInputType`) stays inline at every verbosity. Off by default to keep responses terse; enable when triaging coverage gaps.",
        },
        metaMode: metaModeSchema,
        includeRuleDetails: includeRuleDetailsSchema,
      },
      required: ["paths"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async handler(params, session) {
    const paths = strArrayParam(params, "paths");
    if (!paths || paths.length === 0) {
      return errorResult({
        code: "missing-required-param",
        message: "paths must be a non-empty array of file or directory paths.",
        details: { param: "paths" },
      });
    }

    const cwd = strParam(params, "cwd") ?? process.cwd();
    // Hard-error envelope when every caller-supplied path is missing on
    // disk. Soft-signal (`warnings: ["scanned_zero_files"]`) stays the
    // right shape for "the paths exist but contain no parseable files."
    // Without this split, a typo in `paths` reads the same as a clean
    // codebase — the silent-success failure shape CLAUDE.md §1 warns
    // against.
    const existence = await Promise.all(paths.map((p) => pathExists(p, cwd)));
    const missing = paths.filter((_, i) => !existence[i]);
    if (missing.length === paths.length) {
      return errorResult({
        code: "scan-paths-not-found",
        message: `None of the requested paths exist on disk: ${paths.join(", ")}`,
        details: { paths, missing, cwd },
        remediation:
          "Pass `paths` entries that exist on disk (files or directories). Relative paths resolve against `cwd` when supplied, otherwise against the MCP server's spawn directory.",
      });
    }
    const projectConfig = await session.loadProjectConfig(cwd);
    // Q-SHARED-NO-CONFIG-WARNING-TINY-REPO: probe the same walk-up
    // range the config loader searched for a `package.json` /
    // ra11y.config.* marker. Gates the `no_config_found` warning so
    // tiny-repo / demo-size scans don't rebroadcast the
    // `meta.configSource: null` signal. Only relevant when the loader
    // returned no config.
    const configSearchSawProjectMarker =
      projectConfig.sourcePath === null ? sawProjectMarkerInWalk(cwd) : false;
    const standards = resolveStandards(strParam(params, "standard"), session);
    const files = await parseFiles(paths, session, cwd);
    if (files.length === 0) {
      return textResult({
        // the flat `violations: 0` headline
        // was dropped from the plan shape; on a zero-files scan the
        // honest tally has no lanes to populate, so only `notes` and
        // `summary` ride. Callers that want the flat count sum
        // `plan.fixesByClass` (absent here — present-when-meaningful).
        plan: { notes: 0, summary: "No parseable files found." },
        files: [],
        meta: { filesScanned: 0, scanned: scannedDir(paths) },
        // `scan` takes paths directly and has no root-resolution step,
        // so rootSource is null — `root_source_defaulted` cannot fire
        // here by construction (it's a scan_project-only signal).
        ...warningsField({
          filesScanned: 0,
          rootSource: null,
          configSource: projectConfig.sourcePath,
          configSearchedFromForWarning: cwd,
          analysisCoverage: undefined,
          filesByExtension: undefined,
          configSearchSawProjectMarker,
        }),
      });
    }

    const collected = await runScanAndCollect({
      files,
      session,
      enabled: standards,
      minSeverity: strParam(params, "minSeverity"),
      ruleSettings: session.effectiveRules(projectConfig),
      wrapperSources: buildWrapperSourcesFromConfig(projectConfig, session),
      cwd,
    });
    // Probe `cwd` for files whose extensions match an `eligible === 0`
    // extension-gated rule's gate but didn't reach the scan — drives
    // the `subkind: "extension-present-but-out-of-scope"` discriminator
    // on `meta.perRuleCoverage` rows whose remediation would otherwise
    // misroute (the existing "add additionalPaths for compiled output"
    // text steers agents the wrong way when source files were excluded
    // by `additionalPaths` / `exclude` / `.gitignore` rather than
    // genuinely absent). Bounded directory walk; no-op fast path when
    // no row qualifies. The helper returns a spread-ready fragment so
    // the assembler call below stays straight-line.
    const extensionsField = await probeExtensionsPresentAtRoot({
      cwd,
      perRuleCoverage: collected.perRuleCoverage,
      activeRules: collected.activeRules,
    });
    // Disable the assembler's internal token-density cap so the cap
    // measures the FINAL response shape — after we've overlaid the
    // tool-specific outer fields (scanned, configSource, nextStep,
    // …). Running both would double-count the density measurement on
    // a smaller object. `scan` applies its own cap below via
    // `mergeScanTokenBudget` so the `response_token_budget_truncated`
    // warning code fires alongside `truncated: true`.
    const assembled = assembleScanFamilyResponse(
      {
        ...collected,
        verboseMeta: params["verboseMeta"] === true,
        preset: projectConfig.preset,
        configSource: projectConfig.sourcePath,
        // `scan` takes paths directly and has no root-resolution step,
        // so rootSource is null — `root_source_defaulted` cannot fire
        // here by construction.
        rootSource: null,
        configSearchSawProjectMarker,
        // Surface the loader's search root on
        // `warningsDetails.no_config_found.searchedFrom` so every
        // project-rooted tool answers "where was the search?" the
        // same way.
        configSearchedFromForWarning: cwd,
        ...extensionsField,
      },
      { tokenBudget: 0 },
    );
    const nextStep = buildNextStep({
      plan: assembled.plan,
      files: assembled.files,
      meta: assembled.meta,
      ...(assembled.referenceGuide === undefined
        ? {}
        : { referenceGuide: assembled.referenceGuide }),
      ...(assembled.ruleCoverage === undefined ? {} : { ruleCoverage: assembled.ruleCoverage }),
    });
    const nextStepStructuredField =
      nextStep.structured === undefined ? {} : { nextStepStructured: nextStep.structured };

    const fullMeta: Record<string, unknown> = {
      ...assembled.meta,
      scanned: scannedDir(paths),
      configSource: projectConfig.sourcePath,
      // collapsed the emitted
      // config-resolution context to `configSource` alone here:
      // `configSearchedFrom` was always the caller-supplied `cwd`
      // (pure echo), and `configNote` was a 200-char boilerplate that
      // re-said what the `no_config_found` warning already signals
      // when `configSource === null`. Three fields repeating one bit
      // of information violated the "present-when-meaningful" rule
      // in `.claude/rules/mcp-response-shapes.md`; the warning channel
      // is the canonical "no config was loaded" signal.
      // `nextStep` and
      // `nextStepStructured` moved to the top level of the response
      // (see `tentative` below). One pointer, one place — the
      // load-bearing agent-direction field stays discoverable next
      // to `plan` and `files` rather than buried in scan-confidence
      // telemetry.
    };
    // Hold onto the pre-overlay warnings channel so the
    // `mergeScanTokenBudget` merge can re-emit them alongside the
    // density-cap code. The assembler's `warnings` / `warningsDetails`
    // are the deterministic signal set; density truncation is a
    // secondary concern the merge layers on top.
    const baseWarnings = assembled.warnings ?? [];
    const baseWarningsDetails = assembled.warningsDetails;
    // ADR 0021 amendment (2026-04-20): secondary token-density budget.
    // `scan` has no `limit`/`offset` contract, so when the density cap
    // fires we emit `truncated: true` + `totalFilesWithFindings` + the
    // `response_token_budget_truncated` warning — no `nextOffset`,
    // because the tool has no resumable paging primitive. Progress
    // guarantee: the helper always keeps at least one file.
    const tentative: Record<string, unknown> = {
      plan: assembled.plan,
      files: assembled.files,
      ...(assembled.referenceGuide === undefined
        ? {}
        : { referenceGuide: assembled.referenceGuide }),
      ...(assembled.ruleCoverage === undefined ? {} : { ruleCoverage: assembled.ruleCoverage }),
      ...ruleCatalogField(params, session.registry.rules, assembled.files),
      ...(baseWarnings.length > 0 ? { warnings: baseWarnings } : {}),
      ...(baseWarningsDetails === undefined ? {} : { warningsDetails: baseWarningsDetails }),
      // top-level agent direction.
      // Paired with `nextStepStructured` (conditional-spread so the
      // fallback multi-option prose doesn't ship a sentinel machine
      // hint). One pointer, one place — pre-change `nextStep` sat in
      // `meta` next to scan-confidence telemetry.
      nextStep: nextStep.prose,
      ...nextStepStructuredField,
      meta: applyMetaCacheMode({ toolName: "scan", params, fullMeta, session }),
    };
    const budgeted = applyTokenBudget({
      response: tentative,
      filesKey: "files",
      files: assembled.files,
      offset: 0,
    });
    if (budgeted.droppedCount === 0) return textResult(tentative);
    return textResult(
      mergeScanTokenBudget({
        tentative,
        budgeted,
        baseWarnings,
        totalFilesWithFindings: assembled.files.length,
        requestedLimit: assembled.files.length,
        effectiveLimit: budgeted.files.length,
      }),
    );
  },
};
