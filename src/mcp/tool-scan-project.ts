/**
 * The scan_project MCP tool. Lives in its own file so src/mcp/tools.ts
 * stays under the 500-line file budget — nothing here is meant to be
 * reused by other tools.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ParsedFile } from "../engine/scanner.ts";
import { filesChangedSince, gitRoot, stagedFiles } from "../utils/git.ts";
import { logger } from "../utils/logger.ts";
import { additionalPathsScannedField } from "./additional-paths-classifier.ts";
import { baselineStatusField, probeBaselineStatus } from "./baseline-status.ts";
import {
  type BuildArtifactsGrouped,
  collectBuildArtifacts,
  groupBuildArtifactsByBasename,
  type ScannedBuildArtifact,
} from "./build-artifacts.ts";
import {
  catalogEmptyResultMetaFields,
  detectCatalogShape,
  withCatalogHint,
} from "./catalog-detect.ts";
import { buildConfigHint } from "./config-hint.ts";
import { sawProjectMarkerInWalk } from "./config-search-marker.ts";
import { classifyWrapperCandidates, collectWrapperCandidates } from "./detect-wrappers-core.ts";
import { hasMetaArrayTruncation } from "./meta-array-cap.ts";
import { metaModeSchema } from "./meta-cache.ts";
import { buildNextStep } from "./next-step.ts";
import { hoistAndBuildReferenceGuide } from "./reference-guide.ts";
import { includeRuleDetailsSchema } from "./rule-catalog.ts";
import { assembleScanProjectResponse } from "./scan-project-budget.ts";
import {
  buildScanProjectReviewCandidates,
  type ScanProjectReviewCandidate,
} from "./scan-project-review-candidates.ts";
import { scannedProject } from "./scanned-envelope.ts";
import { skipCriterionSchema, skippedByCallerField } from "./skip-criterion.ts";
import { detectSsgFramework, ssgEmptyResultMetaFields, withSsgHint } from "./ssg-detect.ts";
import {
  collectManualCriteria,
  errorResult,
  type McpTool,
  ms,
  parseExplicitPaths,
  parseFilesWithDiagnostics,
  resolveStandards,
  runScanAndFormat,
  type ScanFormatted,
  type StructuredErrorCode,
  strArrayParam,
  strParam,
  textResult,
} from "./tools-helpers.ts";
import {
  computeTemplateDirectiveOverlap,
  type WarningInputs,
  warningsField,
  warningsFieldFromScanMeta,
} from "./warnings.ts";
import type { NativeWrapperSources } from "./wrappers-meta.ts";

export const scanProjectTool: McpTool = {
  def: {
    name: "scan_project",
    description:
      "Scan the entire project from the repo root. Auto-discovers every HTML/CSS/JSX/TSX/Vue/Svelte file, respecting default ignores (node_modules, dist, test files) and the project's `.gitignore`. Use this for a complete compliance check instead of `scan` when you want to be sure nothing is missed. Returns the scanned root so you can verify coverage. Keep the default minSeverity: 'info' — info findings are things the tool flagged but couldn't verify alone (component wrappers, cross-file references); you should read the source to resolve them. Filtering them out upfront will miss real issues.\n\nAlways pass `cwd` set to your project root — the loader uses it to discover `ra11y.config.ts` and the project's `.gitignore`. Omitting `cwd` falls back to the MCP server's spawn directory, which usually isn't the project root; `meta.configSource` will be null in that case.\n\nFor a pre-commit or CI-on-diff workflow, narrow the scan with `changedOnly: true` (staged files only) or `since: 'main'` (files changed vs a ref, including uncommitted WIP).",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description:
            "Root directory to scan. Defaults to the current working directory. Pass your repo root to scan every parseable file.",
        },
        standard: {
          type: "string",
          description: "Standard ID (e.g. wcag22). Defaults to session config.",
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
            "Minimum severity to include. Default 'info' is recommended — info findings are cases static analysis can't resolve but you can (by reading component source / cross-file references). Only raise to 'warning' for unattended CI gates.",
        },
        changedOnly: {
          type: "boolean",
          description:
            "Scan only files currently staged in git (pre-commit use case). Falls back to a full scan if cwd isn't a git repo.",
        },
        since: {
          type: "string",
          description:
            "Git ref (e.g. 'main', 'HEAD~1'). Scans only files that differ between the ref and HEAD, plus uncommitted WIP. Ideal for CI on a PR diff.",
        },
        verboseMeta: {
          type: "boolean",
          description:
            "When true, analysisCoverage expands its counts into the actual lists — `opaqueCustomComponentNames` (PascalCase tags not in nativeWrappers) and `rulesByExtension` (which rules ran against which file types). `parseErrorFiles` (paths that errored AND produced zero findings; invisible to rules) and `partialParseFiles` (errored + still produced findings) always ship with `{ path, parser, reason }` entries regardless of this flag — the parser + reason pair is the fix pivot; gating it would leave the top-level `parse_errors_present` signal unactionable. Off by default to keep responses terse; enable when triaging coverage gaps.",
        },
        metaMode: metaModeSchema,
        autoDetectWrappers: {
          type: "boolean",
          description:
            "When true, run the `detect_native_wrappers` heuristic inline and register PascalCase-with-onClick components as nativeWrappers for this scan. Use on the first run of a codebase so the opaqueCustomComponents count is accurate without an onboarding round-trip. The detected list is surfaced in `meta.autoDetectedWrappers` — copy the names you confirm to your ra11y.config.ts for durable registration. Scope is scan-only; session and project config are unaffected.",
        },
        additionalPaths: {
          type: "array",
          items: { type: "string" },
          description:
            'Paths to scan in addition to the auto-discovered tree, with `.gitignore` and default build-dir skips (`dist`, `build`, `out`, `.next`, …) bypassed. Use to include post-compile CSS/HTML that Tailwind or the bundler produces — e.g. `["dist/assets"]` — so color-contrast and focus-visible rules have real styles to evaluate. User `exclude` patterns still apply. Relative paths resolve from `cwd`.',
        },
        limit: {
          type: "number",
          description:
            "Maximum number of files (with findings) to include in the response. Defaults to 25 (calibrated per ADR 0021 so the first call stays under typical MCP host token ceilings on medium repos). The scan still runs over every file in scope — the cap only bounds response size. When more files have findings than fit, the response includes `truncated: true` and `nextOffset: N`; call again with `offset: N` to page.",
        },
        offset: {
          type: "number",
          description:
            "Starting index into the full files-with-findings list. Defaults to 0. Use with `limit` + the `nextOffset` from a previous truncated response to iterate.",
        },
        includeRuleDetails: includeRuleDetailsSchema,
        skipCriterion: skipCriterionSchema,
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async handler(params, session) {
    const explicitCwd = strParam(params, "cwd");
    const cwdError = checkCwdExists(explicitCwd);
    if (cwdError) return cwdError;
    // When cwd isn't passed, prefer a host-declared root (MCP
    // `roots` capability) over the spawn directory's git root. The
    // host is the best arbiter of "what project is active right now"
    // — an agent-side IDE will have a declared root even when the
    // server was spawned elsewhere. Fall through to git-root, then
    // process.cwd() for non-root, non-git scans.
    const spawnCwd = process.cwd();
    const hostRoot = explicitCwd === undefined ? session.firstRootPath() : null;
    const root = explicitCwd ?? hostRoot ?? gitRoot(spawnCwd) ?? spawnCwd;
    const autoPromoted = explicitCwd === undefined && root !== spawnCwd;
    const rootSource = resolveRootSource({ explicitCwd, hostRoot, root, spawnCwd });
    const projectConfig = await session.loadProjectConfig(root);
    // Q-SHARED-NO-CONFIG-WARNING-TINY-REPO: probe the same walk-up range
    // the config loader searched for a `package.json` / ra11y.config.*
    // marker. Only relevant when `configSource === null` — when the
    // loader found a config, the probe result isn't consulted. Cheap
    // read-only walk; runs once per handler invocation.
    const configSearchSawProjectMarker =
      projectConfig.sourcePath === null ? sawProjectMarkerInWalk(root) : false;
    const configHint = buildConfigHint(projectConfig.sourcePath, explicitCwd, root, autoPromoted);
    const standards = resolveStandards(strParam(params, "standard"), session);
    const scanScope = resolveScanScope(params, root);
    if (scanScope.kind === "error") return scopeErrorToResult(scanScope);
    const { roots, mode: actualMode, fallbackReason } = scanScope;
    const t0 = performance.now();
    const storybookPresetActive = projectConfig.preset === "storybook";
    const { files: baseFiles, diagnostics: discoveryDiagnostics } = await parseFilesWithDiagnostics(
      roots,
      session,
      root,
      discoverOptionsFor(projectConfig),
    );
    const additionalPaths = strArrayParam(params, "additionalPaths") ?? [];
    const additionalFiles =
      additionalPaths.length > 0 ? await parseExplicitPaths(additionalPaths, session, root) : [];
    const files = mergeFilesByPath(baseFiles, additionalFiles);
    const parseMs = ms(t0);
    if (files.length === 0) {
      logger.debug(`scan_project: 0 parseable files (${parseMs}ms discover)`);
      return buildEmptyFilesResult({
        root,
        actualMode,
        fallbackReason,
        rootSource,
        configSource: projectConfig.sourcePath,
        configSearchSawProjectMarker,
      });
    }
    const autoDetect = params["autoDetectWrappers"] === true;
    // When config is missing, also run the detector so the agent can
    // see what `nativeWrappers` would cover for this codebase — silent
    // misses on onboarding were the most common field report. The
    // detector is O(parsed files) and runs on files we've already
    // parsed, so the extra cost is negligible. Registration is still
    // gated on autoDetect === true; suggestion-only when it's off.
    const configMissing = projectConfig.sourcePath === null;
    const shouldDetect = autoDetect || configMissing;
    const detected = shouldDetect ? collectWrapperCandidates(files) : [];
    const detectedNames = detected.map((c) => c.component);
    const classified = classifyIfAutoDetect(autoDetect, files, detectedNames);
    const t1 = performance.now();
    const skipCriterion = strArrayParam(params, "skipCriterion");
    const { formatted, reviewCandidates: rawReviewCandidates } = await runScanAndFormat(
      files,
      session,
      standards,
      strParam(params, "minSeverity"),
      session.effectiveRules(projectConfig),
      buildWrapperSources(projectConfig, session, classified),
      root,
      params["verboseMeta"] === true,
      skipCriterion,
      projectConfig.preset,
      // Thread declared process page-sets through so project-scoped
      // finders (WCAG 3.2.3 Consistent Navigation, 3.2.4 Consistent
      // Identification) key off the full page set when the user has
      // a `processes` config. Pages are pre-resolved to absolute paths
      // so the finders' `indexFilesByAbsPath` match against
      // `ParsedFile.filePath` (which the discovery pass carries as
      // absolute). The helper internally conditional-spreads onto
      // `runScan` when the array is non-empty.
      resolveProcessesForScan(projectConfig.processes, projectConfig.sourcePath, root),
      // V1-DETECT-SILENT-EXT: surface per-extension skip counts from the
      // discovery pass into `meta.analysisCoverage.skippedByExtension`
      // + the response-level `extensions_skipped_no_parser` warning.
      discoveryDiagnostics,
    );
    logger.debug(
      `scan_project: ${files.length} files, parse ${parseMs}ms + scan ${ms(t1)}ms = ${ms(t0)}ms`,
    );
    // Deterministic compiled-CSS / bundler-output label. Findings on
    // these files STILL appear in `formatted.files` — this is additive
    // information so an agent knows to investigate whether a given
    // finding sits on generated code before editing. Per CLAUDE.md §1
    // "Ambiguous field shapes are dishonest," the field is omitted
    // entirely when the detector finds no artifacts (never `[]`).
    //
    // Hoisted above `buildNextStep` so the classifier's output can
    // also drive Q6-NEXTSTEP-AVOIDS-VENDOR-CSS: the raw `entries` list
    // carries the same absolute-path form that `formatted.files[].path`
    // uses, so the next-step builder can match vendor findings without
    // additional normalization.
    const buildArtifacts = buildArtifactsFields(files, root);
    const nextStep = buildNextStep(formatted, {
      iterativeTip:
        actualMode === "full"
          ? ' For iterative work on a branch, pass `since: "HEAD~1"` or `changedOnly: true` to scan only diffs.'
          : "",
      // Q6-NEXTSTEP-AVOIDS-VENDOR-CSS: when the top-ranked violation
      // sits in vendor code (bootstrap.css, font-awesome.css, etc.)
      // AND a same-`ruleId` finding exists in authored code, the
      // builder reroutes the structured hint to the authored file so
      // the agent's first action lands where it can edit. When no
      // alternative exists, the vendor target stays. Additive — empty
      // set is a no-op.
      vendorPaths: vendorPathSet(buildArtifacts.entries),
    });
    const nextStepStructuredField = structuredField(nextStep);
    // P2-BASE: probe the canonical baseline path so agents see whether
    // a baseline is in play alongside the scan result — prevents
    // re-proposing fixes for grandfathered violations without the
    // separate `baseline check` round-trip. Omitted when no baseline
    // exists (honest shape per CLAUDE.md §1).
    const baselineStatus = await probeBaselineStatus(root);
    // Response-size guard: the scan always runs over every file, but
    // the emitted `files` array is capped so large monorepos don't
    // blow through MCP token limits. `truncated` + `nextOffset` are
    // omitted when the whole result fits.
    const pageParams = readPageParams(params);
    const page = paginateFiles(formatted.files, pageParams);
    // V1-SIZE-RESPONSE-BUDGET-DENSITY option (b): hoist duplicated
    // `fix.description` prose into `referenceGuide.fixDescriptions`
    // over the PAGED `files` — so pointers and the top-level map
    // cover exactly what ships in this response. Running the hoist
    // before pagination would let a description hoist on strength of
    // findings that never reach the caller, leaving a pointer with
    // no lookup target.
    const hoisted = hoistAndBuildReferenceGuide(page.files, formatted.referenceGuide);
    // Q4-SSG-BUILD-HINT: probe the scan root for an SSG config marker
    // (Jekyll / Hugo / Astro / Eleventy / Gatsby / MkDocs). When a
    // framework resolves, `detectedFramework` ships as a structured
    // `meta` field and the `ssgHint` prose is appended to
    // `analysisCoverage.hints` so the agent sees the "build then scan
    // the emitted output" workflow inline with the other coverage
    // advice. Additive surface only — no findings are filtered or
    // downgraded by the detection (CLAUDE.md §1 "Surface, don't
    // suppress").
    const detectedFramework = detectSsgFramework(root);
    // Q6-CATALOG-REPO-SIBLING-HINT: probe the scan root for the
    // "catalog of stand-alone sibling site dirs" shape (e.g. a 174-
    // template website-templates dump). When detected, the per-subdir
    // scan workflow recovers per-site signal that the flat scan
    // conflates — surface a `catalogHint` meta field plus a hint
    // appended to `analysisCoverage.hints` naming the second call
    // shape. Additive surface only — findings stay in `files[]`,
    // nothing is filtered or downgraded (CLAUDE.md §1 "Surface, don't
    // suppress"). Pairs with the SSG-hint shape above: same routing
    // pattern (meta field + analysisCoverage.hints prose), different
    // trigger (sibling-site shape vs. SSG config marker).
    const catalogHint = detectCatalogShape(root);
    const metaWithRouteHints = layerRouteHints(formatted.meta, detectedFramework, catalogHint);
    const fullMeta = {
      ...metaWithRouteHints,
      ...skippedByCallerField(skipCriterion),
      scanned: scannedProject(root),
      scanMode: actualMode,
      ...(fallbackReason === undefined ? {} : { fallbackReason }),
      rootSource,
      ...buildRootsOverlapMeta({ explicitCwd, hostRoot, root, session }),
      configSource: projectConfig.sourcePath,
      // Q6-CONFIG-CONTEXT-TRIPLE-READOUT: `configSearchedFrom` was
      // always equal to `root`, which already ships in `scanned.root`
      // above; `configNote` was a 200-char boilerplate duplicating
      // the `no_config_found` warning's signal (warnings fire on
      // `configSource === null` via `warningsFieldFromScanMeta`
      // below). Three fields re-emitted the same bit — collapsed to
      // `configSource` alone per `.claude/rules/mcp-response-shapes.md`
      // "present-when-meaningful; never sentinel-empty."
      ...baselineStatusField(baselineStatus),
      ...buildArtifacts.metaField,
      ...(configHint === null ? {} : { configHint }),
      ...buildWrapperMeta({ autoDetect, configMissing, detectedNames }),
      ...routeHintMetaFields(detectedFramework, catalogHint),
      ...additionalPathsScannedField({
        additionalPaths,
        filesAdded: files.length - baseFiles.length,
        root,
        excludes: session.config.exclude,
      }),
      nextStep: nextStep.prose,
      ...nextStepStructuredField,
    };
    // Q-SHARED-SCAN-PROJECT-INLINE-REVIEW-CANDIDATES: when the scan
    // produced zero automated findings (`formatted.files.length === 0`)
    // but grounded manual-review candidates survived the per-level
    // `manualIds` filter, surface them inline so the agent has a
    // `file:line` pointer without a separate `checklist` round trip.
    // Omitted when automated-findings files exist (the agent has
    // file:line pointers already and can call `checklist` for the
    // manual half) OR when no grounded candidates survive
    // (present-when-meaningful; never `[]` on the wire). Cap at the
    // caller's `limit` so one noisy finder can't blow the token
    // budget. Helper returns a spreadable record — already empty when
    // the gate fails, so the handler call site stays a single spread.
    const inlineReviewCandidatesField = inlineReviewCandidatesFieldFor({
      formattedFilesCount: formatted.files.length,
      candidates: rawReviewCandidates,
      enabledStandards: standards,
      session,
      files,
      limit: pageParams.limit,
    });
    return textResult(
      assembleScanProjectResponse({
        params,
        session,
        formatted,
        hoisted,
        page,
        pageOffset: pageParams.offset,
        fullMeta,
        ...inlineReviewCandidatesField,
        ...buildBaseWarningsForScanProject({
          formatted,
          parsedFiles: files,
          rootSource,
          configSource: projectConfig.sourcePath,
          buildArtifacts,
          storybookPresetActive,
          sessionWrappersMismatchCwd: session.sessionWrappersMismatchCwd(root),
          additionalPathsRedundant: isAdditionalPathsRedundant({
            additionalPaths,
            additionalFilesCount: additionalFiles.length,
            filesAdded: files.length - baseFiles.length,
          }),
          configSearchSawProjectMarker,
        }),
      }),
    );
  },
};

/**
 * Computes the spreadable `reviewCandidates` field fragment for the
 * narrow case where `scan_project` produced zero automated findings
 * but grounded manual-review candidates are available. Returns an
 * empty record when the gate fails — automated-finding files exist
 * (the agent already has `file:line` pointers and can call `checklist`
 * itself) or no candidates survive the manual-id filter — so the
 * handler call site stays a single unconditional spread.
 * Present-when-meaningful per CLAUDE.md §1 "Ambiguous field shapes
 * are dishonest." Extracted so the handler's cognitive-complexity
 * score stays inside the lint cap.
 */
function inlineReviewCandidatesFieldFor(args: {
  readonly formattedFilesCount: number;
  readonly candidates: readonly import("../types/review.ts").ReviewCandidate[];
  readonly enabledStandards: readonly string[];
  readonly session: import("./session.ts").McpSession;
  readonly files: readonly ParsedFile[];
  readonly limit: number;
}): { readonly reviewCandidates?: readonly ScanProjectReviewCandidate[] } {
  const { formattedFilesCount, candidates, enabledStandards, session, files, limit } = args;
  // Gate 1: when automated findings exist, the agent already has
  // `file:line` pointers — it can choose to call `checklist` itself
  // for the manual half. Don't duplicate that surface (doctrine:
  // "Don't duplicate capability the agent already has").
  if (formattedFilesCount > 0) return {};
  if (candidates.length === 0) return {};
  const manualIds = collectManualCriteria(enabledStandards, session, session.config.level, files);
  const surfaced = buildScanProjectReviewCandidates({ candidates, manualIds, limit });
  if (surfaced.length === 0) return {};
  return { reviewCandidates: surfaced };
}

/**
 * Q6-BUDGET-UNDER-VENDOR-NOISE assembly seam. Cross-references
 * the build-artifact labels with `formatted.files` to detect the
 * vendor-CSS dominance regime, then emits the spreadable
 * `baseWarnings` + `baseWarningsDetails` pair for the assembler.
 * Per doctrine, the finding paths are NOT filtered — the tally
 * only drives an additive warning code + structured payload so
 * the agent sees "vendor filtering first" before re-budgeting.
 * Extracted as its own helper so the handler's cognitive
 * complexity stays inside the lint budget.
 */
function buildBaseWarningsForScanProject(args: {
  readonly formatted: ScanFormatted;
  readonly parsedFiles: readonly ParsedFile[];
  readonly rootSource: "explicit" | "host-root" | "git" | "spawn-cwd";
  readonly configSource: string | null;
  readonly buildArtifacts: {
    readonly present: boolean;
    readonly entries: readonly ScannedBuildArtifact[];
    readonly metaField: { readonly scannedBuildArtifacts?: BuildArtifactsGrouped };
  };
  readonly storybookPresetActive: boolean;
  readonly sessionWrappersMismatchCwd: boolean;
  readonly additionalPathsRedundant: boolean;
  readonly configSearchSawProjectMarker: boolean;
}): {
  readonly baseWarnings?: readonly import("./warnings.ts").ScanWarningCode[];
  readonly baseWarningsDetails?: import("./warnings.ts").ScanWarningDetails;
} {
  const {
    formatted,
    parsedFiles,
    rootSource,
    configSource,
    buildArtifacts,
    storybookPresetActive,
    sessionWrappersMismatchCwd,
    additionalPathsRedundant,
    configSearchSawProjectMarker,
  } = args;
  const vendorCssNoise = computeVendorCssNoise(buildArtifacts.entries, formatted.files);
  // Q4-WARNING-DOWNGRADE-NOISE: gate the `template_files_parsed_as_literal`
  // code on actual overlap between findings and directive lines —
  // see the code's doctrine comment in `src/mcp/warnings.ts`. Pull
  // `(filePath, line)` tuples out of every finding `formatted.files`
  // already grouped; cross-reference against per-file source text
  // indexed by `ParsedFile.filePath`.
  const templateDirectivesOverlap = computeTemplateDirectiveOverlap({
    findings: formatted.files.flatMap((f) =>
      f.findings.map((fn) => ({ filePath: f.path, line: fn.line })),
    ),
    sourcesByPath: new Map(parsedFiles.map((f) => [f.filePath, f.source])),
  });
  const warningsFromMeta = warningsFieldFromScanMeta({
    meta: formatted.meta,
    rootSource,
    configSource,
    scannedBuildArtifactsPresent: buildArtifacts.present,
    storybookPresetActive,
    sessionWrappersMismatchCwd,
    templateDirectivesOverlap,
    additionalPathsRedundant,
    configSearchSawProjectMarker,
    // Q-SHARED-META-ARRAY-BUDGET-CAP: scan-project is the primary
    // driver of meta-array bloat (CSS build-artifact tails, parse-
    // error dumps on bulk-template repos). We look at the assembled
    // meta directly — including the `scannedBuildArtifacts`
    // sub-object the caller just mixed in — so every capped array
    // in scope is covered. Pure over the assembled meta; no
    // duplicated predicate at each cap call site.
    metaArrayTruncated: hasMetaArrayTruncation({
      ...formatted.meta,
      ...buildArtifacts.metaField,
    }),
    ...(vendorCssNoise === undefined ? {} : { vendorCssNoise }),
  });
  return warningsFieldsForAssembler(warningsFromMeta);
}

/**
 * Narrows the spreadable `warningsField`-shaped object into the
 * discrete `baseWarnings` + `baseWarningsDetails` keys the
 * assembler expects — both conditional-spread so absent fields
 * are omitted rather than sentineled (CLAUDE.md §1 "Ambiguous
 * field shapes are dishonest"). Extracted so the handler's
 * cognitive complexity stays inside the lint budget.
 */
function warningsFieldsForAssembler(warningsFromMeta: {
  readonly warnings?: readonly import("./warnings.ts").ScanWarningCode[];
  readonly warningsDetails?: import("./warnings.ts").ScanWarningDetails;
}): {
  readonly baseWarnings?: readonly import("./warnings.ts").ScanWarningCode[];
  readonly baseWarningsDetails?: import("./warnings.ts").ScanWarningDetails;
} {
  const codes = warningsFromMeta.warnings;
  const details = warningsFromMeta.warningsDetails;
  return {
    ...(codes === undefined ? {} : { baseWarnings: codes }),
    ...(details === undefined ? {} : { baseWarningsDetails: details }),
  };
}

/**
 * Cross-references the build-artifact detector's output with the
 * per-file findings list to drive the
 * `vendor_css_dominates_findings` warning. Returns `undefined`
 * when the scan produced no findings at all (the dominance
 * question isn't meaningful on a clean scan) — otherwise returns
 * the tally plus the densest CSS build-artifact file so the
 * warning payload has a concrete first-pivot.
 *
 * CSS-only scope: JS/HTML build artifacts (sourcemap pairs,
 * `dist/*.js`) are surfaced under `scanned_build_artifacts_present`
 * but aren't counted here — the dominance regime we're naming is
 * specifically "vendor CSS bundles (bootstrap.css, font-awesome.css,
 * compiled Tailwind) firing contrast / motion rules at scale," not
 * the broader "build artifact presence" signal.
 */
function computeVendorCssNoise(
  buildArtifacts: readonly ScannedBuildArtifact[],
  files: ScanFormatted["files"],
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
 * Maps a loaded project config onto the discovery-side options
 * `parseFiles` accepts. Today only `preset: "storybook"` widens
 * discovery to include `*.stories.*` / `*.story.*` files; the helper
 * keeps the conditional spread out of the handler so
 * `scan_project`'s cognitive-complexity budget doesn't grow every
 * time a preset-driven flag is added.
 */
function discoverOptionsFor(projectConfig: import("../types/config.ts").LoadedConfig): {
  readonly includeStoryFiles?: boolean;
} {
  return projectConfig.preset === "storybook" ? { includeStoryFiles: true } : {};
}

/**
 * Pre-resolves `projectConfig.processes` page paths to absolute form
 * so project-scoped finders (WCAG 3.2.3 / 3.2.4) match them against
 * `ParsedFile.filePath` — which the discovery pass stores as absolute.
 * Relative pages resolve against the config file's directory when the
 * config was found on disk, else against the scan root. Absolute pages
 * pass through unchanged. Empty input returns an empty array so the
 * call site can forward unconditionally.
 */
function resolveProcessesForScan(
  processes: readonly import("../types/config.ts").Process[],
  configSourcePath: string | null,
  root: string,
): readonly import("../types/config.ts").Process[] {
  if (processes.length === 0) return processes;
  const base = configSourcePath === null ? root : dirname(configSourcePath);
  return processes.map((p) => ({
    ...p,
    pages: p.pages.map((pagePath) => (isAbsolute(pagePath) ? pagePath : resolve(base, pagePath))),
  }));
}

/**
 * One-hop AST probe (P1-F): when autoDetect is on, split detected
 * names into `confirmed` (defining file's JSX root is a native
 * interactive element) vs `assumed` (can't confirm). Only confirmed
 * names reach the effective native-wrapper allowlist and silence
 * findings; assumed names stay opaque so the scanner treats the
 * component like any other unresolved PascalCase element. Extracted
 * so the handler stays under Biome's cognitive-complexity cap.
 */
function classifyIfAutoDetect(
  autoDetect: boolean,
  files: readonly ParsedFile[],
  detectedNames: readonly string[],
): { readonly confirmed: readonly string[]; readonly assumed: readonly string[] } {
  if (!autoDetect) return { confirmed: [], assumed: [] };
  return classifyWrapperCandidates(files, detectedNames);
}

/**
 * Builds the `NativeWrapperSources` payload handed to
 * `runScanAndFormat`. `fromAutoDetect` rides its own channel — the
 * session-override audit (`sessionOverridesNote` + `source: "session"`
 * entries in the unified `activeNativeWrappers` list) must not
 * mis-attribute scan-scoped auto-detected names to a stale
 * configure() call. Confirmed vs assumed split carries through to
 * the tagged list as `source: "autoDetect"` entries with
 * `confirmed: true|false`. The `fromAutoDetect` key is omitted
 * entirely when autoDetect produced no candidates, so the shape
 * never ships an empty `{confirmed: [], assumed: []}`.
 *
 * The `fromFileElements` / `fromSessionElements` maps thread through
 * so `activeNativeWrapperElements` shows up in the response envelope
 * and wrapper-opt-in rules see the object form via `RuleContext`.
 * Both fields are conditional-spread so array-form configs stay
 * identical on the wire.
 */
function buildWrapperSources(
  projectConfig: import("../types/config.ts").LoadedConfig,
  session: import("./session.ts").McpSession,
  classified: { readonly confirmed: readonly string[]; readonly assumed: readonly string[] },
): NativeWrapperSources {
  const autoDetectHasAny = classified.confirmed.length > 0 || classified.assumed.length > 0;
  const fileElements = projectConfig.nativeWrapperElements;
  const sessionElements = session.config.nativeWrapperElements;
  return {
    fromFile: projectConfig.nativeWrappers,
    ...(Object.keys(fileElements).length > 0 ? { fromFileElements: fileElements } : {}),
    fromSession: session.config.nativeWrappers,
    ...(Object.keys(sessionElements).length > 0 ? { fromSessionElements: sessionElements } : {}),
    ...(autoDetectHasAny ? { fromAutoDetect: classified } : {}),
  };
}

/**
 * Names the reason this scan picked `root`. Surfaces as `rootSource`
 * in `meta` so agents can tell whether they're scanning what the host
 * expected — `explicit` / `host-root` / `git` / `spawn-cwd` — without
 * reading server logs.
 */
function resolveRootSource(args: {
  explicitCwd: string | undefined;
  hostRoot: string | null;
  root: string;
  spawnCwd: string;
}): "explicit" | "host-root" | "git" | "spawn-cwd" {
  if (args.explicitCwd !== undefined) return "explicit";
  if (args.hostRoot !== null && args.root === args.hostRoot) return "host-root";
  if (args.root !== args.spawnCwd) return "git";
  return "spawn-cwd";
}

/**
 * Surface overlap when the caller *and* the host both had an opinion
 * about the scan scope. Explicit cwd wins (see precedence in the
 * handler), but we note that the host's first root differs so the
 * agent can decide whether to flip to the host's preference next call.
 */
interface RootsOverlapArgs {
  explicitCwd: string | undefined;
  hostRoot: string | null;
  root: string;
  session: import("./session.ts").McpSession;
}

function buildRootsOverlapMeta(args: RootsOverlapArgs): Record<string, unknown> {
  const { explicitCwd, root, session } = args;
  const roots = session.roots;
  if (roots.length === 0) return {};
  const firstPath = session.firstRootPath();
  if (explicitCwd !== undefined && firstPath !== null && explicitCwd !== firstPath) {
    return {
      hostDeclaredRoots: roots.map((r) => r.uri),
      rootsOverlapNote: `Host declared ${roots.length} root(s); explicit cwd \`${explicitCwd}\` overrides. First host root is \`${firstPath}\`. Scanning \`${root}\`.`,
    };
  }
  return { hostDeclaredRoots: roots.map((r) => r.uri) };
}

/**
 * Builds the wrapper-related meta fields. Two distinct shapes:
 *   - `autoDetectedWrappers` + note: registered for this scan (flag on).
 *   - `suggestedNativeWrappers` + note: onboarding hint only (config
 *     missing, flag off) — NOT registered. The agent retries with
 *     `autoDetectWrappers: true` or writes a config.
 * Empty object when neither applies.
 */
function buildWrapperMeta(args: {
  autoDetect: boolean;
  configMissing: boolean;
  detectedNames: readonly string[];
}): Record<string, unknown> {
  const { autoDetect, configMissing, detectedNames } = args;
  if (autoDetect) {
    return {
      autoDetectedWrappers: detectedNames,
      autoDetectedWrappersNote:
        detectedNames.length === 0
          ? "autoDetectWrappers ran but found no PascalCase components with onClick to register."
          : `autoDetectWrappers registered ${detectedNames.length} component(s) for this scan only. For durable registration, add them to \`nativeWrappers\` in ra11y.config.ts — if the file does not exist, create it with:\n\n  import { defineConfig } from "@ra11y/core";\n\n  export default defineConfig({\n    nativeWrappers: [${detectedNames.map((n) => `"${n}"`).join(", ")}],\n  });\n\nRemove any that actually render a <div>/<span> internally — those are real bugs.`,
    };
  }
  if (configMissing && detectedNames.length > 0) {
    const nameList = detectedNames.map((n) => `"${n}"`).join(", ");
    return {
      suggestedNativeWrappers: detectedNames,
      suggestedNativeWrappersNote: `No ra11y.config.ts was found, but the detector spotted ${detectedNames.length} PascalCase component(s) with onClick that look like native-element wrappers. To use them for this scan, re-call scan_project with \`autoDetectWrappers: true\`. To make it durable, create \`ra11y.config.ts\` at the project root with:\n\n  import { defineConfig } from "@ra11y/core";\n\n  export default defineConfig({\n    nativeWrappers: [${nameList}],\n  });\n\nNot yet registered for this scan.`,
    };
  }
  return {};
}

// Next-step prose is built by the shared `buildNextStep` helper
// (`src/mcp/next-step.ts`) so scan_project and scan_file stay in
// lockstep. A prior in-file implementation drifted from scan_file's
// shape; the extraction is deliberate parity infrastructure, not a
// refactor for its own sake.

/**
 * The scan scope for a given `scan_project` invocation. Either the
 * (roots, mode) pair the scanner consumes — with an optional
 * `fallbackReason` when the requested mode couldn't execute and we
 * degraded to a full scan — or an `error` descriptor the handler
 * surfaces via `errorResult` before any scan work happens.
 *
 * The error variant exists for `changedOnly: true` inside a git repo
 * with zero staged files: the previous behavior silently fell back to
 * a full scan AND reported `scanMode: "changedOnly"`, which made
 * pre-commit / CI-on-diff workflows believe their diff gate was
 * working when it wasn't. Hard-erroring is the honest shape.
 *
 * The `full-fallback` variant covers `changedOnly: true` outside a git
 * repo — genuinely unavoidable, but we stop lying about what ran by
 * reporting `scanMode: "full-fallback"` + a named `fallbackReason`.
 */
type ScanScope =
  | {
      readonly kind: "scan";
      readonly roots: readonly string[];
      readonly mode: string;
      readonly fallbackReason?: string;
    }
  | {
      readonly kind: "error";
      readonly code: StructuredErrorCode;
      readonly message: string;
      readonly details: Record<string, unknown>;
      readonly remediation: string;
    };

/**
 * Decides which files to scan, and what to truthfully report as
 * `scanMode`, based on the git-aware params. Three branches:
 *
 *   - `changedOnly: true`:
 *       - not a git repo        → full-fallback (kept for compatibility
 *                                  with the pre-fix behavior, but now
 *                                  with a named fallbackReason).
 *       - repo, nothing staged  → error envelope `no_staged_files`.
 *       - repo, files staged    → scan those paths as `changedOnly`.
 *   - `since: "<ref>"`:
 *       - empty result          → full-fallback (fallbackReason names why).
 *       - any result            → scan those paths as `since:<ref>`.
 *   - neither flag              → full scan of `root`.
 */
function resolveScanScope(params: Record<string, unknown>, root: string): ScanScope {
  const changedOnly = (params as { changedOnly?: unknown }).changedOnly === true;
  const since = strParam(params, "since");
  if (changedOnly) {
    if (gitRoot(root) === null) {
      return {
        kind: "scan",
        roots: [root],
        mode: "full-fallback",
        fallbackReason: "not-a-git-repo",
      };
    }
    const files = stagedFiles(root);
    if (files.length === 0) {
      return {
        kind: "error",
        code: "no-staged-files",
        message:
          "changedOnly: true was set, but no files are staged in the git index — the scan would silently run against the full tree. Stage the files you want to scan, or omit changedOnly to request a full scan explicitly.",
        details: { gitRoot: gitRoot(root), cwd: root },
        remediation:
          "Stage files with `git add <path>` before calling with changedOnly: true; or drop changedOnly to run a full scan.",
      };
    }
    return { kind: "scan", roots: files, mode: "changedOnly" };
  }
  if (since !== undefined && since.length > 0) {
    if (gitRoot(root) === null) {
      return {
        kind: "scan",
        roots: [root],
        mode: "full-fallback",
        fallbackReason: "not-a-git-repo",
      };
    }
    const files = filesChangedSince(since, root);
    if (files.length === 0) {
      return {
        kind: "scan",
        roots: [root],
        mode: "full-fallback",
        fallbackReason: `no-files-changed-since:${since}`,
      };
    }
    return { kind: "scan", roots: files, mode: `since:${since}` };
  }
  return { kind: "scan", roots: [root], mode: "full" };
}

/**
 * Narrows a `ScanScope` error variant to the MCP `errorResult` shape.
 * Lives next to `resolveScanScope` so the error-surfacing path and the
 * scope-decision path stay together, and extracted as its own function
 * so the handler's cognitive complexity stays linear — the early-return
 * plus the `if (files.length === 0)` branch would otherwise tip it over
 * the lint threshold.
 */
function scopeErrorToResult(scope: Extract<ScanScope, { kind: "error" }>) {
  return errorResult({
    code: scope.code,
    message: scope.message,
    details: scope.details,
    remediation: scope.remediation,
  });
}

/**
 * Builds the zero-parseable-files response, with truthful scan-mode and
 * optional `fallbackReason` (when git-aware narrowing fell back to a
 * full scan that still parsed nothing). Extracted so the handler's
 * cognitive-complexity score stays under the lint cap.
 */
function buildEmptyFilesResult(args: {
  readonly root: string;
  readonly actualMode: string;
  readonly fallbackReason: string | undefined;
  readonly rootSource: "explicit" | "host-root" | "git" | "spawn-cwd";
  readonly configSource: string | null;
  readonly configSearchSawProjectMarker: boolean;
}) {
  const { root, actualMode, fallbackReason, rootSource, configSource } = args;
  return textResult({
    plan: { violations: 0, notes: 0, summary: "No parseable files found." },
    files: [],
    meta: {
      filesScanned: 0,
      scanned: scannedProject(root),
      scanMode: actualMode,
      ...(fallbackReason === undefined ? {} : { fallbackReason }),
      // Q4-SSG-BUILD-HINT: zero-parseable-files on an SSG root is
      // canonically "all the markup lives in fragments the scanner
      // doesn't parse." Surface the framework + hint so the agent has
      // the build command and emit dir inline.
      ...mergeEmptyResultHints(ssgEmptyResultMetaFields(root), catalogEmptyResultMetaFields(root)),
    },
    // Zero parsed files → the `no_config_found` warning drops by
    // construction via the `filesScanned < 10` gate; the probe flag is
    // threaded through for shape consistency but the warnings helper
    // will see filesScanned: 0 and never emit the code here.
    ...warningsField({
      filesScanned: 0,
      rootSource,
      configSource,
      analysisCoverage: undefined,
      filesByExtension: undefined,
      configSearchSawProjectMarker: args.configSearchSawProjectMarker,
    }),
  });
}

/**
 * Merges two empty-result hint fragments so the
 * `analysisCoverage.hints` arrays from each detector concatenate
 * cleanly. Non-`analysisCoverage` keys (e.g. `detectedFramework`,
 * `catalogHint`) are merged with later entries winning per spread
 * semantics. Returns an empty object when both inputs are empty so
 * the caller can spread unconditionally per CLAUDE.md §1 "Ambiguous
 * field shapes are dishonest."
 *
 * Lives next to `buildEmptyFilesResult` because that's the only call
 * site — the populated branch goes through the `withSsgHint` /
 * `withCatalogHint` combinators which already handle the same merge.
 */
function mergeEmptyResultHints(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.keys(a).length === 0) return b;
  if (Object.keys(b).length === 0) return a;
  const merged: Record<string, unknown> = { ...a, ...b };
  const aHints = readHintsArray(a);
  const bHints = readHintsArray(b);
  if (aHints.length > 0 || bHints.length > 0) {
    const baseCoverage =
      typeof merged["analysisCoverage"] === "object" && merged["analysisCoverage"] !== null
        ? (merged["analysisCoverage"] as Record<string, unknown>)
        : {};
    merged["analysisCoverage"] = { ...baseCoverage, hints: [...aHints, ...bHints] };
  }
  return merged;
}

/**
 * Reads `analysisCoverage.hints` out of a hint-fragment object.
 * Returns an empty array when the fragment doesn't have the shape —
 * lets {@link mergeEmptyResultHints} concatenate without per-call
 * type guards.
 */
function readHintsArray(fragment: Record<string, unknown>): readonly string[] {
  const coverage = fragment["analysisCoverage"];
  if (typeof coverage !== "object" || coverage === null) return [];
  const hintsRaw = (coverage as Record<string, unknown>)["hints"];
  if (!Array.isArray(hintsRaw)) return [];
  return hintsRaw.filter((h): h is string => typeof h === "string");
}

/**
 * Q4-ADDITIONALPATHS-REDUNDANT predicate. Returns true when the
 * caller supplied `additionalPaths`, those paths resolved to at
 * least one parseable file, AND every one of those parsed files was
 * already in the default-discovered base set — i.e. the merge pass
 * de-duped every additional file. Distinguishes "flag did nothing
 * because paths were ignored" (per-path `skipped` reasons under
 * `additionalPathsScanned.skipped`) from "flag did nothing because
 * paths were already covered" — two cases with different
 * remediations (fix the path vs. drop the param). Lives as its own
 * function so the handler's cognitive complexity stays inside the
 * lint budget.
 */
function isAdditionalPathsRedundant(args: {
  readonly additionalPaths: readonly string[];
  readonly additionalFilesCount: number;
  readonly filesAdded: number;
}): boolean {
  if (args.additionalPaths.length === 0) return false;
  if (args.additionalFilesCount === 0) return false;
  return args.filesAdded === 0;
}

/**
 * De-dupes a second batch of parsed files against the first by
 * filePath. `additionalPaths` is meant for targets that wouldn't
 * otherwise be scanned, but a caller can overlap them with the main
 * tree — in that case the original parsed file wins.
 */
function mergeFilesByPath<T extends { readonly filePath: string }>(
  primary: readonly T[],
  secondary: readonly T[],
): readonly T[] {
  if (secondary.length === 0) return primary;
  const seen = new Set(primary.map((f) => f.filePath));
  const extras = secondary.filter((f) => !seen.has(f.filePath));
  if (extras.length === 0) return primary;
  return [...primary, ...extras];
}

/**
 * Hard-error envelope when the caller passed a `cwd` that doesn't
 * exist on disk. Without this, `parseFiles` returns 0 silently and
 * the response shape reads as a clean codebase — the silent-success
 * failure mode CLAUDE.md §1 warns against. Returns `null` when `cwd`
 * is undefined or exists; returns the error envelope otherwise.
 * Extracted from the handler to keep its cognitive complexity inside
 * the lint budget.
 */
function checkCwdExists(explicitCwd: string | undefined): ReturnType<typeof errorResult> | null {
  if (explicitCwd === undefined) return null;
  if (existsSync(explicitCwd)) return null;
  return errorResult({
    code: "cwd-not-found",
    message: `Requested cwd does not exist on disk: ${explicitCwd}`,
    details: { cwd: explicitCwd },
    remediation:
      "Pass `cwd` as a path to an existing directory. Relative paths resolve against the MCP server's spawn directory.",
  });
}

/**
 * Conditional-spread the structured form of `nextStep` — omitted when
 * the prose degrades to generic advice (no concrete first finding), per
 * CLAUDE.md §1 "Ambiguous field shapes are dishonest." Lets the
 * handler spread unconditionally.
 */
function structuredField(nextStep: { readonly structured?: unknown }): {
  readonly nextStepStructured?: unknown;
} {
  if (nextStep.structured === undefined) return {};
  return { nextStepStructured: nextStep.structured };
}

/**
 * Build-artifacts spread: the raw `entries` list (for downstream
 * cross-referencing against findings, e.g. the vendor-CSS dominance
 * predicate), a `metaField` to mix into `meta` (omitted when no
 * artifacts), and a `present` boolean for
 * `warningsFieldFromScanMeta`.
 *
 * Q6-SCANNED-BUILD-ARTIFACTS-GROUP-BY-BASENAME: the meta field
 * carries the {@link BuildArtifactsGrouped} shape (grouped +
 * ungrouped) rather than the flat `ScannedBuildArtifact[]` it used
 * to. Per CLAUDE.md §1 "Verbose meta is signal, not clutter," the
 * grouped form is a strict superset — every ≥3-entry basename
 * cluster collapses to one row with a paste-ready `suggestedGlob`,
 * and sub-threshold entries stay in `ungrouped` so zero information
 * is lost. The raw `entries` list stays in the worker-internal
 * return shape for the vendor-CSS dominance predicate, which cross-
 * references path-level classification against findings.
 */
function buildArtifactsFields(
  files: readonly ParsedFile[],
  root: string,
): {
  readonly present: boolean;
  readonly entries: readonly ScannedBuildArtifact[];
  readonly metaField: { readonly scannedBuildArtifacts?: BuildArtifactsGrouped };
} {
  const entries = collectBuildArtifacts(files);
  if (entries.length === 0) {
    return { present: false, entries, metaField: {} };
  }
  const grouped = groupBuildArtifactsByBasename(entries, root);
  return {
    present: true,
    entries,
    metaField: { scannedBuildArtifacts: grouped },
  };
}

/**
 * Q6-NEXTSTEP-AVOIDS-VENDOR-CSS. Build a hash-set of the absolute
 * filePaths the classifier flagged as build artifacts, so
 * `buildNextStep`'s reroute predicate can lookup by path in O(1).
 * The set carries the same absolute-path form that
 * `formatted.files[].path` uses — the classifier's input is
 * `ParsedFile.filePath`, which is the same value `rule-runner.ts`
 * stamps onto every violation's `location.filePath` — so the set is
 * a drop-in path-equality key with no normalization. Empty input
 * yields an empty set (the builder short-circuits when
 * `vendorPaths.size === 0`, making the whole Q6 code path a no-op
 * for clean repos).
 */
function vendorPathSet(entries: readonly ScannedBuildArtifact[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const e of entries) out.add(e.path);
  return out;
}

/**
 * Layers the SSG and catalog routing hints into the scanner-produced
 * `meta` block in one pass. Each combinator is a no-op when its
 * signal is absent, so the call site stays a single unconditional
 * expression regardless of whether either detector fired. Extracted
 * from the handler so its cognitive-complexity score stays inside
 * the lint budget — the SSG detector and catalog detector both
 * append to `analysisCoverage.hints` and both ride their own meta
 * field, and stacking two combinator calls inline pushed the
 * handler past the noComplexity cap.
 *
 * Ordering is deterministic: SSG hint first, then catalog hint,
 * matching the read-order an agent triaging scan_project output
 * walks through `analysisCoverage.hints`.
 */
function layerRouteHints(
  meta: Record<string, unknown>,
  detectedFramework: import("./ssg-detect.ts").DetectedFramework | null,
  catalogHint: import("./catalog-detect.ts").CatalogHint | null,
): Record<string, unknown> {
  return withCatalogHint(withSsgHint(meta, detectedFramework), catalogHint);
}

/**
 * Assembles the spreadable structured-field fragment for the two
 * routing hints that ride their own meta keys (`detectedFramework`
 * and `catalogHint`). Both are conditional-spread — absent when the
 * corresponding detector returned `null` — so the handler's
 * expression has one spread instead of two, keeping its cognitive-
 * complexity score inside the lint cap per CLAUDE.md §1 "Ambiguous
 * field shapes are dishonest."
 */
function routeHintMetaFields(
  detectedFramework: import("./ssg-detect.ts").DetectedFramework | null,
  catalogHint: import("./catalog-detect.ts").CatalogHint | null,
): Record<string, unknown> {
  return {
    ...(detectedFramework === null ? {} : { detectedFramework }),
    ...(catalogHint === null ? {} : { catalogHint }),
  };
}

/**
 * Default files-with-findings cap per scan_project response (P1-OVF +
 * ADR 0021). Calibrated at 25 so the first call stays under the ~100 KB
 * MCP host token ceiling on typical medium repos (~2.9 KB/file amortized
 * on the reported Bootstrap profile → ~72 KB at 25 files). Callers who
 * want the old wider window set `limit: 200` explicitly; MAX_PAGE_LIMIT
 * (2000) is unchanged. See docs/adr/0021-scan-response-size-budget.md.
 */
const DEFAULT_PAGE_LIMIT = 25;
/** Minimum caller-supplied limit. Below this we clamp up. */
const MIN_PAGE_LIMIT = 1;
/** Maximum caller-supplied limit. Above this we clamp down. */
const MAX_PAGE_LIMIT = 2000;

interface PageParams {
  readonly limit: number;
  readonly offset: number;
}

/** Reads limit/offset params with sensible clamping. */
function readPageParams(params: Record<string, unknown>): PageParams {
  const rawLimit = typeof params["limit"] === "number" ? params["limit"] : DEFAULT_PAGE_LIMIT;
  const rawOffset = typeof params["offset"] === "number" ? params["offset"] : 0;
  const limit = Math.max(MIN_PAGE_LIMIT, Math.min(MAX_PAGE_LIMIT, Math.floor(rawLimit)));
  const offset = Math.max(0, Math.floor(rawOffset));
  return { limit, offset };
}

/**
 * Slices the per-file findings list by `offset`/`limit` and returns the
 * page plus the conditional `truncated`/`nextOffset` fields to spread
 * into the response. Honest-shape: both pagination fields are omitted
 * together when the whole result fits (CLAUDE.md §1 "Ambiguous field
 * shapes are dishonest" — `truncated: false` would be dishonest since
 * it reads as "present but nothing to report").
 */
function paginateFiles<T>(
  files: readonly T[],
  { limit, offset }: PageParams,
): {
  readonly files: readonly T[];
  readonly paginationFields: {
    readonly truncated?: true;
    readonly nextOffset?: number;
    readonly totalFilesWithFindings?: number;
  };
} {
  const page = files.slice(offset, offset + limit);
  const hasMore = offset + limit < files.length;
  if (!hasMore && offset === 0) {
    return { files: page, paginationFields: {} };
  }
  return {
    files: page,
    paginationFields: {
      ...(hasMore ? { truncated: true as const, nextOffset: offset + limit } : {}),
      totalFilesWithFindings: files.length,
    },
  };
}
