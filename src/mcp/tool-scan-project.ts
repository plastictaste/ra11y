/**
 * The scan_project MCP tool. Lives in its own file so src/mcp/tools.ts
 * stays under the 500-line file budget — nothing here is meant to be
 * reused by other tools.
 */

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ParsedFile } from "../engine/scanner.ts";
import type { PerRuleCoverage } from "../types/violation.ts";
import { filesChangedSince, gitRoot, stagedFiles } from "../utils/git.ts";
import { logger } from "../utils/logger.ts";
import { posixDirname, posixResolve } from "../utils/path.ts";
import {
  additionalPathsScannedField,
  classifyAdditionalPathSkips,
} from "./additional-paths-classifier.ts";
import { baselineStatusField, probeBaselineStatus } from "./baseline-status.ts";
import {
  type BuildArtifactClassification,
  type BuildArtifactsGrouped,
  collectBuildArtifacts,
  type DetectedVendorLibrary,
  detectVendorLibraries,
  groupBuildArtifactsByBasename,
  type ScannedBuildArtifact,
} from "./build-artifacts.ts";
import { type BulkCatalogDetection, detectBulkCatalog } from "./bulk-catalog.ts";
import {
  catalogEmptyResultMetaFields,
  detectCatalogShape,
  withCatalogHint,
} from "./catalog-detect.ts";
import { buildConfigHint } from "./config-hint.ts";
import { nearestConfigAncestorPath, sawProjectMarkerInWalk } from "./config-search-marker.ts";
import { classifyWrapperCandidates, collectWrapperCandidates } from "./detect-wrappers-core.ts";
import { detectDynamicContentContainers } from "./dynamic-content-container.ts";
import { buildFileLimitation } from "./file-limitations.ts";
import type { Hint } from "./hint-codes.ts";
import { getTruncatedMetaArrayFields } from "./meta-array-cap.ts";
import { metaModeSchema } from "./meta-cache.ts";
import {
  buildNextStep,
  bulkVendorScopeDownNextStep,
  type NextStepResult,
  type NextStepStructured,
  shouldRerouteToBulkVendorScopeDown,
  smallDemoCatalogGroupByNextStep,
} from "./next-step.ts";
import { requireBooleanParam, requireStringArrayParam } from "./param-validators.ts";
import { enrichFindingsWithCodeDemoPropMatch } from "./per-finding-code-demo-prop-confidence.ts";
import {
  type CorpusWarningFiles,
  enrichFindingsWithCorpusWarningFiles,
} from "./per-finding-corpus-warning-files.ts";
import { hoistAndBuildReferenceGuide } from "./reference-guide.ts";
import { buildReviewCandidatePrompts } from "./review-candidate-prompts.ts";
import { includeRuleDetailsSchema } from "./rule-catalog.ts";
import {
  detectLinkedStylesheetsNotResolvedForContrast,
  isPerRuleCoverageUniformlyHigh,
  withActionableManualItemsBySource,
  withFindingsByFile,
  withFindingsByRule,
  withTopDirectories,
  withTopRules,
  withViolationsByScanKind,
} from "./scan-assembly.ts";
import { GROUP_BY_VALUES, readGroupByParam, withByGroup } from "./scan-group-by.ts";
import {
  assembleScanProjectResponse,
  buildVendorPredicate,
  pickNonVendorNarrowingDir,
} from "./scan-project-budget.ts";
import { rewriteResponseToCollapsed } from "./scan-project-collapse-by-group.ts";
import {
  buildScanProjectReviewCandidates,
  type ScanProjectReviewCandidate,
} from "./scan-project-review-candidates.ts";
import { buildSummaryOnlyResponse } from "./scan-project-summary-only.ts";
import {
  combineTemplateLiteralFiles,
  computeAnimationLibraryGuardCandidates,
  computeVendorCssNoise,
} from "./scan-time-warnings.ts";
import { scannedProject } from "./scanned-envelope.ts";
import { skipCriterionSchema, skippedByCallerField } from "./skip-criterion.ts";
import { detectSsgFramework, ssgEmptyResultMetaFields, withSsgHint } from "./ssg-detect.ts";
import {
  computePerStyleTemplateLiteralFiles,
  perStyleLiteralFilesField,
} from "./template-literal-per-style.ts";
import {
  collectManualCriteria,
  errorResult,
  type McpTool,
  type McpToolResult,
  ms,
  parseExplicitPaths,
  parseFilesWithDiagnostics,
  resolveStandards,
  runScanAndFormat,
  type ScanFormatted,
  type StructuredError,
  type StructuredErrorCode,
  strArrayParam,
  strParam,
  textResult,
} from "./tools-helpers.ts";
import { enrichPerRuleCoverageWithVendorConcentration } from "./vendor-concentration.ts";
import {
  computeTemplateDirectiveOverlap,
  SCANNED_BUILD_ARTIFACTS_TOP_CAP,
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
            "When true, the meta block expands its compact summaries into the underlying per-row payloads. Affects: `perRuleCoverage[]` (full per-rule coverage rows with concentration / parse-error confidence reasons / cross-file limitation reasons — at default verbosity replaced by `perRuleCoverageSummary: { ruleCount, ruleIds }`) and analysisCoverage's `opaqueCustomComponentNames` (PascalCase tags not in nativeWrappers) + `rulesEligibleByExtension` (which rules were eligible to run against which file types — eligibility, not actual emission; the per-rule actual-fire tally lives on `perRuleCoverage[].filesEvaluated`). `parseErrorFiles` (paths that errored AND produced zero findings; invisible to rules) and `partialParseFiles` (errored + still produced findings) always ship with `{ path, parserAttempted, naturalParser?, reason }` entries regardless of this flag — `parserAttempted` is the parser the dispatcher actually invoked, `naturalParser` is present-when-meaningful (surfaced only when the dispatcher routed through a non-natural parser, e.g. `.js` → tsx); the parser + reason pair is the fix pivot, and gating it would leave the top-level `parse_errors_present` signal unactionable. The scan-confidence telemetry (`configSource`, `activeNativeWrappers`, `rulesEvaluated`, `filesByExtension`, `rulesNotEvaluatedDueToInputType`, warnings) stays inline at every verbosity. Off by default so bulk-shipping responses fit under typical MCP host token ceilings; enable when triaging coverage gaps or auditing per-rule confidence.",
        },
        metaMode: metaModeSchema,
        autoDetectWrappers: {
          type: "boolean",
          description:
            'When true, run the `detect_native_wrappers` heuristic inline and register PascalCase-with-onClick components as nativeWrappers for this scan. Use on the first run of a codebase so the opaqueCustomComponents count is accurate without an onboarding round-trip. The detector outcome is surfaced as `meta.autoDetectedWrappers: { ran: true, candidates: [...] }` — the object form distinguishes "ran and found nothing" (empty `candidates`) from "detector did not run" (field omitted). Copy the confirmed names to your ra11y.config.ts for durable registration. Scope is scan-only; session and project config are unaffected.',
        },
        additionalPaths: {
          type: "array",
          items: { type: "string" },
          description:
            'Paths to scan in addition to the auto-discovered tree, with `.gitignore` and default build-dir skips (`dist`, `build`, `out`, `.next`, …) bypassed. Use to include post-compile CSS/HTML that Tailwind or the bundler produces — e.g. `["dist/assets"]` — so color-contrast and focus-visible rules have real styles to evaluate. User `exclude` patterns still apply. Relative paths resolve from `cwd`. This flag only ADDS files; to scope a project scan to a subdirectory, use `restrictToPaths` instead.',
        },
        restrictToPaths: {
          type: "array",
          items: { type: "string" },
          description:
            'Restrict the scan to files at or beneath the listed paths. Discovery still walks the full project (so `.gitignore`, default ignores, and configured excludes apply uniformly), then the resulting file set is intersected with these paths. Use to scope a project scan to one or more subdirectories without sacrificing the project-aware shape of `scan_project` (config resolution, root-source telemetry, baseline probe, paging) — the alternative `scan` tool has a different response shape and no paging. Each entry may be a directory (matches every parseable file beneath it) or a single file. Relative paths resolve from `cwd`. Combines with `additionalPaths`: any `additionalPaths` files added to the merged set are intersected too. When the intersection is empty, the response carries the `restrict_to_paths_no_matches` warning so the caller can distinguish "scoped scan with nothing to do" from "the paths did not match."',
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
        groupBy: {
          type: "string",
          enum: [...GROUP_BY_VALUES],
          description:
            "Aggregate findings into a `plan.byGroup` summary keyed by `firstChildDir` (relative-to-cwd first path segment — the high-leverage case for catalog repos with N parallel sub-project subdirectories), `directory` (relative-to-cwd parent directory of each file), or `extension` (file extension without the leading dot). Each group reports `{ violations, filesWithFindings, mostCommonRule?, mostCommonCriterion? }`. The flat `files[]` list still ships in full — `byGroup` is an additive aggregator, not a replacement. Use this on bulk-template repos with parallel sub-projects to get one response with N rows per sub-project rather than N round-trips with `additionalPaths` per sub-project.",
        },
        collapseByGroupKey: {
          type: "boolean",
          description:
            'When true, replace the per-file `files[]` view with a per-group `collapsedGroups[]` view: one entry per unique `(ruleId, groupKey)` carrying the canonical finding\'s `findingId`/`severity`/`fix`/etc. plus an `occurrences[]: [{path, line, column}]` enumeration of every emission that shared the predicate. Use on bulk-template catalogs (e.g. 174 sub-sites repeating the same Bootstrap navbar) where 40k per-file findings collapse to <500 unique groups — one `scan_project` call answers "what kinds of problems exist?" without paging through every file. Pagination/truncation semantics mirror the per-file path (`limit`, `offset`, `truncated`, `nextOffset`); the only shape change is the primary findings array. Headline counts on `plan` (`fixesByClass.*`, `topRules`, etc.) stay un-collapsed so the agent budgets against the real finding count; `plan.collapsedGroupCount` exposes the post-collapse count alongside so the two views reconcile. Default false preserves the existing per-file shape exactly.',
        },
        summaryOnly: {
          type: "boolean",
          description:
            "When true, omit the per-file `files[]` array entirely and ship only the headline rollups: `plan` (with `topRules`, `findingsByFile`, `findingsByRule`, `fixesByClass`, `summary`, manual-review counters), `meta` slimmed to scan-confidence telemetry (including `filesByExtension` and `analysisCoverage`), `nextStep`/`nextStepStructured`, and `warnings`/`warningsDetails`. Designed as the bulk-corpus first-call ergonomic — on catalogs with 4000+ files producing 40k+ findings, the standard envelope cannot fit per-file findings under the host token cap and falls back to the slim envelope after a full assembly pass; `summaryOnly: true` is the explicit opt-in shortcut. The response carries `summaryOnly: true` and `filesArrayDropped: true` discriminators so the caller distinguishes summary mode from a clean scan of zero files. Recommended workflow: first call `scan_project({ cwd, summaryOnly: true })` to learn which rules and files dominate (`findingsByRule` gives the full per-rule distribution; `findingsByFile` ranks the densest files), then re-call with `restrictToPaths: [<dominant path>]` (without `summaryOnly`) to get per-file findings on a narrower scope. Default false preserves the existing per-file shape exactly.",
        },
        includeReferenceGuide: {
          type: "boolean",
          description:
            "When true, include the top-level `referenceGuide` object containing `suppressPlacement` (per-file-extension prose explaining where to drop `<!-- ra11y-disable -->` / `{/* ra11y-disable */}` pragmas) and `fixDescriptions` (per-rule deduplicated fix prose, referenced from individual findings via `fix.descriptionRef.hash`). Default false omits the block entirely and keeps full `fix.description` prose inline on every finding — typical responses save ~30-40 KB and stay under tighter MCP host token ceilings. Recommended workflow: enable on the FIRST `scan_project` / `scan_file` call of a session to learn the suppression-placement convention and fix-description prose layout for the rules you'll be triaging; subsequent calls within the same session can leave it off (the conventions don't change between calls). Inline `fix.description` is always honest — the opt-in only controls whether the duplicates get hoisted to a top-level lookup table.",
        },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async handler(params, session) {
    // Reject type-mismatched inputs and missing-cwd up front in one
    // pass. A caller sending `autoDetectWrappers: "true"` (string) or
    // `additionalPaths: "src"` (single string) under the previous
    // loose guards got back a successful response that honored none
    // of the requested settings, indistinguishable from "I never
    // asked." Closes the silent-drop class for this handler.
    const explicitCwd = strParam(params, "cwd");
    const earlyError = scanProjectEarlyValidation(params, explicitCwd);
    if (earlyError !== undefined) return earlyError;
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
    const {
      files: baseFiles,
      diagnostics: discoveryDiagnostics,
      jsInnerHtmlDeclinedCount,
      jsInnerHtmlPatternSamples,
      codeDemoPropMatches,
    } = await parseFilesWithDiagnostics(roots, session, root, discoverOptionsFor(projectConfig));
    const additionalPaths = strArrayParam(params, "additionalPaths") ?? [];
    const additionalFiles =
      additionalPaths.length > 0 ? await parseExplicitPaths(additionalPaths, session, root) : [];
    const mergedFiles = mergeFilesByPath(baseFiles, additionalFiles);
    // see {@link applyRestrictToPaths}.
    // Discovery still walked the full project so excludes / gitignore /
    // default ignores apply uniformly; the restriction only scopes
    // which discovered files reach the scanner. Empty-intersection
    // signal rides on `meta.restrictToPathsApplied` + the
    // `restrict_to_paths_no_matches` warning code, so a scoped scan
    // with no matches doesn't read as a clean codebase (CLAUDE.md §1
    // "Zero-output success is ambiguous failure").
    const { files, restrictApplied, restrictAppliedField } = applyRestrictToPaths(
      params,
      mergedFiles,
      root,
    );
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
        restrictAppliedField,
        restrictToPathsEmpty: didRestrictToPathsEmptyTheSet(restrictApplied),
        // probe strict ancestors
        // for a `ra11y.config.*` / `package.json` marker so the
        // empty-files branch can fire `cwd_appears_misrooted` with the
        // ancestor path the agent re-scopes to. Read-only one-pass walk;
        // returns `undefined` when no ancestor qualifies (the bare
        // `scanned_zero_files` stays the honest signal in that case).
        nearestConfigAncestor: nearestConfigAncestorPath(root),
      });
    }
    // When config is missing, also run the detector so the agent can
    // see what `nativeWrappers` would cover for this codebase — silent
    // misses on onboarding were the most common field report. The
    // detector is O(parsed files) and runs on files we've already
    // parsed, so the extra cost is negligible. Registration is still
    // gated on autoDetect === true; suggestion-only when it's off.
    // Helper merges the autoDetect / configMissing predicate pair
    // and the resulting candidate / classified outputs so the handler
    // doesn't carry their decision branches against the lint cap.
    const wrapperDetection = resolveWrapperDetection({
      params,
      projectConfig,
      files,
    });
    const { autoDetect, configMissing, detectedNames, classified } = wrapperDetection;
    const t1 = performance.now();
    const skipCriterion = strArrayParam(params, "skipCriterion");
    const scanRunResult = await runScanAndFormat(
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
      // surface per-extension skip counts from the
      // discovery pass into `meta.analysisCoverage.skippedByExtension`
      // + the response-level `text_source_skipped` /
      // `binary_assets_skipped` warnings.
      discoveryDiagnostics,
    );
    // Per-finding propagation for the MDX code-demo prop axis. When a
    // finding's `(filePath, line)` falls inside a recorded
    // `<Example|Demo|Playground>` code-demo prop body the parser
    // descended into, append `template_literal_in_code_demo_prop` to
    // `couldBeWrongBecause` so the per-finding channel and the
    // corpus-level `jsx_code_demo_prop_parsed_as_live_dom` warning
    // ship consistent attention-budget signals. Surface, don't
    // suppress — severity stays the rule's choice. No-op fast path
    // when the matches map is empty (object identity stable on the
    // common case — non-MDX repos pay no walk).
    const codeDemoEnrichedFiles = enrichFindingsWithCodeDemoPropMatch(
      scanRunResult.formatted.files,
      codeDemoPropMatches,
    );
    // Per-finding propagation for the per-FILE axis on corpus-level
    // warnings whose evidence carries a file list. Companion to the
    // per-LINE pass above: where the line-range gate tags only
    // findings INSIDE a recorded code-demo prop body, this pass tags
    // every finding on a file the warning's payload names — including
    // findings outside any recorded body range. Doctrine source:
    // docs/kb/architecture/ai-first-consumer.md "Per-finding confidence
    // must reflect per-rule coverage limitations" extended to
    // corpus-level warnings: when the warning channel ships
    // `jsx_code_demo_prop_parsed_as_live_dom.files: ["docs/forms.mdx"]`
    // and a per-finding entry on `docs/forms.mdx` ships at
    // `confidence: "medium", couldBeWrongBecause: undefined`, the
    // warning channel and the per-finding channel disagree silently.
    // No-op fast path when no warning's file set is non-empty.
    const enrichedFiles = enrichFindingsWithCorpusWarningFiles(
      codeDemoEnrichedFiles,
      buildCorpusWarningFilesForScanProject(codeDemoPropMatches),
    );
    const formatted: ScanFormatted = { ...scanRunResult.formatted, files: enrichedFiles };
    const rawReviewCandidates = scanRunResult.reviewCandidates;
    const scssUnresolvedVariableFiles = scanRunResult.scssUnresolvedVariableFiles;
    const adjustedPerRuleCoverage = scanRunResult.adjustedPerRuleCoverage;
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
    // also drive: the raw `entries` list
    // carries the same absolute-path form that `formatted.files[].path`
    // uses, so the next-step builder can match vendor findings without
    // additional normalization.
    const buildArtifacts = buildArtifactsFields(files, root);
    const vendorPaths = vendorPathSet(buildArtifacts.entries);
    // stamp
    // `concentration.kind: "vendor"` on perRuleCoverage rows whose
    // densest file is a vendor build artifact AND whose count clears
    // the stricter vendor-only floor (see `VENDOR_CONCENTRATION_MIN_TOTAL`).
    // Additive annotation only — every finding continues to ship in
    // `files[].findings` (surface-don't-suppress). Helper returns the
    // input meta by identity when no row was rewritten.
    const formattedMetaWithVendor = withVendorEnrichedPerRuleCoverage(formatted.meta, vendorPaths);
    // stamp the per-scan-kind
    // violation tally on `plan.violationsByScanKind` so the agent can
    // tell at a glance how many error+warning findings sit in vendor /
    // build-artifact files (often un-editable; the productive triage
    // is `propose_config` exclude or source-level disable, not a fix
    // attempt) vs. authored source. The headline ships
    // deterministically (no conditional spread) so the agent reads
    // one stable shape across vendor and no-vendor scans alike — on
    // a no-artifacts scan, `buildArtifact` reads 0 as honest "axis
    // tallied, found zero" signal rather than being silently absent.
    // Per `docs/kb/architecture/ai-first-consumer.md` "Composite
    // headline counts are dishonest" inverse: a missing headline
    // forces silent recomputation from `plan.fixesByClass`
    // arithmetic. Each per-kind lane (`source`, `buildArtifact`)
    // names exactly one kind of thing, so the split itself is honest.
    // The flat `plan.violations` counter was deleted — the per-kind
    // sibling sums to the structured `plan.fixesByClass` total instead.
    // The shared `formatted.plan` reference is reused below in
    // `assembleScanProjectResponse`; rebinding here propagates the
    // enriched plan through the rest of the assembly chain without
    // forcing a second pass through the helper.
    // stamp `plan.topRules` so a bulk
    // scan (≈1800-file catalog) doesn't force the agent to page through
    // every file just to learn which rules dominated. Computed over the
    // FULL `formatted.files` list — not the paged subset — so the
    // headline describes the whole scan regardless of which page the
    // caller fetched. The pieces (`findingsEmitted` per rule,
    // `concentration.file` per rule) already live in
    // `meta.perRuleCoverage`; this rollup exposes the same information
    // sorted at the headline so the agent can route triage
    // ("`explain_rule` on the dominant rule" / "narrow scope" /
    // "propose_config exclude") in one read. Identity-stable when no
    // error/warning findings emerged.
    const groupByStrategy = readGroupByParam(params["groupBy"]);
    const formattedWithScanKind: ScanFormatted = {
      ...formatted,
      plan: withByGroup(
        // stamp `plan.topDirectories` —
        // the per-first-child-dir rank-ordered rollup that lets the
        // agent triaging a mono-repo of mini-projects (50 demos, an N-
        // template catalog) pick the dominant sub-tree in one read.
        // The orthogonal axis to `topRules` (per-rule) and
        // `findingsByFile` (per-file): same severity filter, same
        // whole-scan framing, different aggregation key. Identity-
        // stable when no error/warning findings emerged or when every
        // finding falls in one bucket — the no-rank-to-expose case the
        // helper short-circuits to keep the wire shape honest.
        // `withFindingsByRule` adds the FULL per-rule count map next
        // to the rank-ordered `withTopRules` head — same severity
        // filter so the per-rule numbers agree on every overlapping
        // ruleId. Lets an agent paginating by rule (per-rule
        // `scan_file({ruleId})` round-trips, per-rule fix batches)
        // budget the round-trip cost without paging through `files[]`
        // — `topRules` only carries the dominant ten, while bulk
        // catalogs routinely have a long tail of rules with single-
        // digit counts that still matter for budgeting.
        withTopDirectories(
          withFindingsByRule(
            withFindingsByFile(
              withTopRules(
                withViolationsByScanKind(
                  withActionableManualItemsBySource(
                    formatted.plan,
                    scanRunResult.actionableCriteriaPaths,
                    vendorPaths,
                  ),
                  formatted.files,
                  vendorPaths,
                ),
                formatted.files,
              ),
              formatted.files,
            ),
            formatted.files,
          ),
          formatted.files,
          root,
        ),
        formatted.files,
        root,
        groupByStrategy,
      ),
    };
    // probe the canonical baseline path so agents see whether
    // a baseline is in play alongside the scan result — prevents
    // re-proposing fixes for grandfathered violations without the
    // separate `baseline check` round-trip. Omitted when no baseline
    // exists (honest shape per CLAUDE.md §1).
    const baselineStatus = await probeBaselineStatus(root);
    // Response-size guard: the scan always runs over every file, but
    // the emitted `files` array is capped so large monorepos don't
    // blow through MCP token limits. `truncated` + `nextOffset` are
    // omitted when the whole result fits. Computed before `buildNextStep`
    // so the truncation predicate can feed the next-step picker — per
    // the AI-first doctrine "NextStep prioritization on truncated/bulk
    // responses must avoid first-by-filename routing," the picker
    // reroutes alphabetical-first to the highest-firing non-vendor
    // rule's first finding when the response can't carry the whole
    // inventory.
    const pageParams = readPageParams(params);
    const page = paginateFiles(formatted.files, pageParams);
    const willBeTruncated = page.paginationFields.truncated === true;
    // hoist bulk-catalog detection above `nextStep` so the
    // `small_demo_catalog` trigger can drive the `groupBy:
    // "firstChildDir"` proposal alongside the existing
    // `warningsDetails.bulk_catalog_detected` payload. Single
    // `detectBulkCatalog` call serves both surfaces — the warning
    // pipeline below reuses this same value rather than re-detecting.
    const bulkCatalogDetection = detectBulkCatalog({
      durationMs: readMetaNumber(formatted.meta, "durationMs"),
      filesScanned: readMetaNumber(formatted.meta, "filesScanned"),
      buildArtifacts: buildArtifacts.entries,
      parsedFilePaths: files.map((f) => f.filePath),
      root,
    });
    const baseNextStep = buildNextStep(formatted, {
      iterativeTip:
        actualMode === "full"
          ? ' For iterative work on a branch, pass `since: "HEAD~1"` or `changedOnly: true` to scan only diffs.'
          : "",
      // when the top-ranked violation
      // sits in vendor code (bootstrap.css, font-awesome.css, etc.)
      // AND a same-`ruleId` finding exists in authored code, the
      // builder reroutes the structured hint to the authored file so
      // the agent's first action lands where it can edit. When no
      // alternative exists, the vendor target stays. Additive — empty
      // set is a no-op.
      vendorPaths,
      // when the response will ship
      // `truncated: true`, the alphabetical first pick is a poor
      // default — visual-regression fixtures, scaffold dirs, and
      // underscore-prefixed templates routinely sort earliest on a
      // paged corpus. Reroute to the highest-firing non-vendor rule's
      // first finding so the agent's first action lands on the rule
      // with broadest authored impact. Density-cap-driven truncation
      // (`mergeBudgetedFields`) is handled by the existing per-rule
      // narrowing reroute downstream; this addresses the standard
      // pagination path where the existing reroute's preconditions
      // don't fire.
      truncated: willBeTruncated,
    });
    // when the corpus carries ≥ 10
    // build-artifact basename groups AND > 50 files-with-findings, the
    // standard `suggest_fix` first call routes the agent into vendor
    // code it can't edit. Override to a structural scope-down naming
    // the top suggestedGlob entries inline, structured-pointing at
    // `propose_config` so the agent's first action emits the exclude
    // block deterministically. The per-finding vendor reroute inside
    // `buildNextStep` only swaps WHICH vendor finding the agent is
    // pointed at; this override addresses the orthogonal regime where
    // the corpus shape itself argues for a config-level fix before any
    // per-file action. Standard nextStep stays when either threshold
    // fails — the override is additive routing for the bulk-vendor
    // pathology, not a suppression of the standard hint.
    const afterBulkVendorOverride = applyBulkVendorScopeDownOverride({
      baseNextStep,
      buildArtifacts,
      totalFilesWithFindings: formatted.files.length,
      files: formatted.files,
    });
    // when the bulk-catalog detector classified the corpus as
    // `small_demo_catalog` (≥30 sibling subdirs sharing the same per-
    // dir basename signature, no vendor-classified files), the catalog
    // shape IS the canonical case for `groupBy: "firstChildDir"`. The
    // override proposes that re-call so the agent gets one whole-tree
    // scan with per-sub-project aggregation rather than paging
    // file-by-file or running N round-trips with `additionalPaths`.
    // Per the AI-first doctrine "One tool call should answer 'what
    // next?'", `nextStepStructured` names the alternative narrowing
    // path explicitly so the agent never has to discover the existing
    // `groupBy` capability out-of-band.
    //
    // Skipped when the caller already passed `groupBy` (the proposal
    // would echo their own parameter), when the bulk-vendor override
    // already replaced the structured target (vendor exclude is the
    // first lever per `bulk-catalog.ts` precedence), or when the
    // detector didn't fire `small_demo_catalog`.
    const nextStep = applySmallDemoCatalogGroupByOverride({
      baseNextStep: afterBulkVendorOverride,
      bulkCatalogDetection,
      callerGroupBy: groupByStrategy,
      cwd: root,
    });
    // option (b): hoist duplicated
    // `fix.description` prose into `referenceGuide.fixDescriptions`
    // over the PAGED `files` — so pointers and the top-level map
    // cover exactly what ships in this response. Running the hoist
    // before pagination would let a description hoist on strength of
    // findings that never reach the caller, leaving a pointer with
    // no lookup target.
    //
    // when the caller did not opt in via `includeReferenceGuide:
    // true`, skip the hoist entirely. `fix.description` stays inline
    // on every finding (no dangling `descriptionRef` pointers) and
    // the top-level `referenceGuide` block is omitted from the
    // response, saving ~30-40 KB on dense scans where
    // `suppressPlacement` + `fixDescriptions` dominate the response
    // payload. Per the AI-first doctrine "Verbose meta is signal,
    // not clutter" the guide is valuable scan-context — the opt-in
    // framing keeps it discoverable via tool description rather than
    // permanently stripping it.
    const includeReferenceGuide = params["includeReferenceGuide"] === true;
    const hoisted = includeReferenceGuide
      ? hoistAndBuildReferenceGuide(page.files, formatted.referenceGuide)
      : { files: page.files, referenceGuide: undefined };
    // annotate each per-file
    // entry with `limitations` when the underlying ParsedFile carried
    // parse errors. Scoped to files currently on this page so the
    // enrichment cost tracks the response size, not the whole scan —
    // every file in `hoisted.files` has findings by construction (only
    // finding-bearing files reach `files[]`), so any parse-errored file
    // in here is a `partial_parse` case. Pure parse-error (0 findings)
    // files stay surfaced via `meta.analysisCoverage.parseErrorFiles`;
    // the per-file limitation is for the degraded-recall signal that
    // would otherwise be invisible when a file emitted findings.
    const enrichedHoistedFiles = attachPerFileLimitations(hoisted.files, files);
    const hoistedWithLimitations = { ...hoisted, files: enrichedHoistedFiles };
    // probe the scan root for an SSG config marker
    // (Jekyll / Hugo / Astro / Eleventy / Gatsby / MkDocs). When a
    // framework resolves, `detectedFramework` ships as a structured
    // `meta` field and the `ssgHint` prose is appended to
    // `analysisCoverage.hints` so the agent sees the "build then scan
    // the emitted output" workflow inline with the other coverage
    // advice. Additive surface only — no findings are filtered or
    // downgraded by the detection (CLAUDE.md §1 "Surface, don't
    // suppress").
    //
    // Corpus evidence (frontmatter fences, Liquid/ERB tokens) lifted
    // off `analysisCoverage` feeds the sentinelless Jekyll fallback:
    // when `_config.yml` is absent at root but `_layouts/` +
    // `_includes/` are present, the corpus signals raise the
    // calibrated confidence one step each. Closes the silent-miss
    // case where a corpus with unambiguous Jekyll evidence (336
    // frontmatter files, `_layouts/`, `_includes/`, Liquid+ERB
    // tokens) but no `_config.yml` shipped `detectedFramework: null`.
    // Per `docs/kb/architecture/ai-first-consumer.md` "Verbose meta
    // is signal, not clutter" — the corroborating evidence the
    // scanner has access to must reach the framework label, not be
    // ignored.
    const detectedFramework = detectSsgFramework(
      root,
      ssgCorpusEvidenceFromMeta(formattedMetaWithVendor),
    );
    // probe the scan root for the
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
    const metaWithRouteHints = layerRouteHints(
      formattedMetaWithVendor,
      detectedFramework,
      catalogHint,
    );
    const fullMeta = {
      ...metaWithRouteHints,
      ...skippedByCallerField(skipCriterion),
      scanned: scannedProject(root),
      scanMode: actualMode,
      ...(fallbackReason === undefined ? {} : { fallbackReason }),
      rootSource,
      ...buildRootsOverlapMeta({ explicitCwd, hostRoot, root, session }),
      configSource: projectConfig.sourcePath,
      // `configSearchedFrom` was
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
        filesAdded: mergedFiles.length - baseFiles.length,
        root,
        excludes: session.config.exclude,
      }),
      ...restrictAppliedField,
      // `nextStep` and
      // `nextStepStructured` ship at the top level of the response, not
      // inside `meta`. They reach the assembler below via explicit
      // fields so the one-pointer-one-place discipline is visible at the
      // call site.
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
      // Plumb scan root for path normalization in the per-emission
      // `findingId` hash so this surface produces the SAME id the
      // shared `computeCandidateFindingId` helper produces on
      // `scan_file.reviewCandidates[]` and `checklist.items[]
      // .candidates[]` for the same conceptual candidate. Per
      // `docs/kb/architecture/ai-first-consumer.md` "Per-finding
      // identifiers must be addressable, not collision-prone" +
      // "Per-tool review-candidate shape must agree across surfaces."
      scanRoot: root,
    });
    // Compute base warnings once — the same payload threads into
    // either the standard `assembleScanProjectResponse` path or the
    // `summaryOnly: true` slim envelope. Hoisted from the
    // assembler-args spread so the summary path can read identical
    // warning state without re-running the corpus-shape detectors.
    const baseWarningsField = buildBaseWarningsForScanProject({
      formatted,
      parsedFiles: files,
      rootSource,
      configSource: projectConfig.sourcePath,
      root,
      buildArtifacts,
      storybookPresetActive,
      sessionWrappersMismatchCwd: session.sessionWrappersMismatchCwd(root),
      additionalPathsRedundant: isAdditionalPathsRedundant({
        additionalPaths,
        additionalFilesCount: additionalFiles.length,
        filesAdded: mergedFiles.length - baseFiles.length,
      }),
      redundantAdditionalPathsList: redundantAdditionalPathsListFor({
        additionalPaths,
        root,
        excludes: session.config.exclude,
      }),
      restrictToPathsEmpty: didRestrictToPathsEmptyTheSet(restrictApplied),
      configSearchSawProjectMarker,
      scssUnresolvedVariableFiles,
      bulkCatalogDetection,
      jsInnerHtmlDeclinedCount,
      jsInnerHtmlPatternSamples,
      codeDemoPropMatches,
      perRuleCoverageUniformlyHigh: isPerRuleCoverageUniformlyHigh(adjustedPerRuleCoverage),
    });
    // Summary-only mode: skip the per-file `files[]` array entirely
    // so the bulk-corpus first-call ships under the host token cap.
    // The agent reads `plan.topRules` / `plan.findingsByFile` /
    // `plan.fixesByClass` to route the second call (typically
    // `restrictToPaths` to a sub-tree, or `explain_rule` on the
    // dominant rule) without paging through 4000+ file entries the
    // standard envelope would have to clip anyway. Returns the
    // summary envelope or `undefined` to continue with the standard
    // assembly path; the divert lives in its own helper so the
    // handler's cognitive-complexity score stays inside the lint cap.
    const summaryDivert = maybeBuildSummaryOnlyResult({
      params,
      formatted: formattedWithScanKind,
      fullMeta,
      baseWarningsField,
    });
    if (summaryDivert) return summaryDivert;
    const assembledResponse = assembleScanProjectResponse({
      params,
      session,
      // pass the scan-kind-enriched
      // `formatted` (its `plan.violationsByScanKind` sibling lands
      // on the wire) into the assembler. Identity-stable when no
      // build artifacts were classified — `withViolationsByScanKind`
      // returns the input plan unchanged in that case.
      formatted: formattedWithScanKind,
      hoisted: hoistedWithLimitations,
      page,
      pageOffset: pageParams.offset,
      fullMeta,
      nextStep: nextStep.prose,
      ...(nextStep.structured === undefined ? {} : { nextStepStructured: nextStep.structured }),
      ...inlineReviewCandidatesField,
      ...baseWarningsField,
    });
    return textResult(
      maybeApplyCollapsedView({
        params,
        assembledResponse,
        fullFiles: formattedWithScanKind.files,
        pageParams,
      }),
    );
  },
};

/**
 * V1-GROUPKEY-COLLAPSED-RESPONSE-MODE entry point. When the caller
 * passes `collapseByGroupKey: true`, swap the assembled per-file
 * `files[]` view for a per-group `collapsedGroups[]` view; otherwise
 * return the assembled response unchanged. Extracted from the handler
 * so its cognitive-complexity score stays inside the lint budget.
 *
 * Per the AI-first consumer doctrine "Cross-surface count invariant,"
 * the rewrite stamps `plan.collapsedGroupCount` so the post-collapse
 * group count ships alongside the un-collapsed `plan.fixesByClass.*`
 * headlines — the agent reads both numbers in the same response and
 * never has to guess which view drove pagination.
 */
function maybeApplyCollapsedView(args: {
  readonly params: Record<string, unknown>;
  readonly assembledResponse: Record<string, unknown>;
  readonly fullFiles: ScanFormatted["files"];
  readonly pageParams: { readonly limit: number; readonly offset: number };
}): Record<string, unknown> {
  if (args.params["collapseByGroupKey"] !== true) return args.assembledResponse;
  return rewriteResponseToCollapsed(args.assembledResponse, {
    fullFiles: args.fullFiles,
    pageParams: args.pageParams,
  });
}

/**
 * `summaryOnly: true` divert. Returns the slim summary envelope when
 * the caller passed the flag; returns `undefined` otherwise so the
 * handler proceeds to the standard `assembleScanProjectResponse`
 * path. Extracted from the handler so its cognitive-complexity score
 * stays inside the lint budget.
 *
 * The summary envelope is built from {@link buildSummaryOnlyResponse}
 * — the heavy lifting of slimming `meta`, building `nextStep`, and
 * shaping the discriminator pair (`summaryOnly: true` +
 * `filesArrayDropped: true`) lives there. This wrapper threads the
 * pre-computed `baseWarningsField` through so the warning channel on
 * the summary envelope agrees with what the standard path would have
 * emitted on the same scan (cross-surface consistency per the
 * doctrine bullet "Per-tool lane and warning-set classification must
 * agree").
 */
function maybeBuildSummaryOnlyResult(args: {
  readonly params: Record<string, unknown>;
  readonly formatted: ScanFormatted;
  readonly fullMeta: Record<string, unknown>;
  readonly baseWarningsField: {
    readonly baseWarnings?: readonly import("./warnings.ts").ScanWarningCode[];
    readonly baseWarningsDetails?: import("./warnings.ts").ScanWarningDetails;
  };
}): McpToolResult | undefined {
  if (args.params["summaryOnly"] !== true) return undefined;
  const { formatted, fullMeta, baseWarningsField } = args;
  return textResult(
    buildSummaryOnlyResponse({
      formatted,
      fullMeta,
      ...(baseWarningsField.baseWarnings === undefined
        ? {}
        : { warnings: baseWarningsField.baseWarnings }),
      ...(baseWarningsField.baseWarningsDetails === undefined
        ? {}
        : { warningsDetails: baseWarningsField.baseWarningsDetails }),
    }),
  );
}

/**
 * Defensive number read from `formatted.meta` for the bulk-catalog
 * detector inputs. `meta.durationMs` and `meta.filesScanned` are
 * always populated by the scan harness today (see
 * `src/mcp/scan-assembly.ts` — both are required schema fields), but
 * the detector stays total over hostile shapes by treating any
 * non-number as zero so the predicate falls through to "no detection"
 * rather than throwing on a bad meta block.
 */
function readMetaNumber(meta: Record<string, unknown>, key: string): number {
  const v = meta[key];
  return typeof v === "number" ? v : 0;
}

/**
 * Collects `.js` files in `parsedFiles` where the routed TSX parser
 * recorded one or more parse errors AND the post-scan formatted files
 * carry no findings on that file — i.e. the routing decision actually
 * dropped content. Drives the `parser_bailed_on_non_jsx_in_tsx_route`
 * warning code on the `scan_project` surface; same predicate as the
 * shared scan-time-warnings aggregator in `scan-time-warnings.ts` so
 * the cross-surface count invariant holds.
 *
 * The earlier predicate counted "successfully parsed `.js` files" (zero
 * errors), which surfaced the warning even on clean parses where 86
 * rules fired and `perRuleCoverage` was uniformly `high`. The doctrine
 * bullet "Empty `warningsDetails.<code>: {}` is dishonest" + "Routing
 * skips that drop content" together require actual bail evidence; the
 * conjunction (extension + parse-error + zero findings) is the per-file
 * analogue of the project-shape `parser_bailed_zero_findings` code.
 * Extracted as a helper so `buildBaseWarningsForScanProject` stays
 * under the cognitive-complexity cap.
 */
function collectParserBailedJsTsxRouteFiles(
  parsedFiles: readonly ParsedFile[],
  formattedFiles: readonly { readonly path: string; readonly findings: readonly unknown[] }[],
): readonly string[] {
  const findingBearingPaths = new Set<string>();
  for (const f of formattedFiles) {
    if (f.findings.length > 0) findingBearingPaths.add(f.path);
  }
  const out: string[] = [];
  for (const file of parsedFiles) {
    if (!file.filePath.toLowerCase().endsWith(".js")) continue;
    if (file.ast.errors.length === 0) continue;
    if (findingBearingPaths.has(file.filePath)) continue;
    out.push(file.filePath);
  }
  out.sort();
  return out;
}

/**
 * Cross-references the per-file inline-HTML pattern detector map with
 * the post-scan finding-bearing path set, returning one representative
 * `{ path, line, pattern }` sample per file the routed parser produced
 * zero findings on. Mirrors `collectInlineHtmlFileSamples` in
 * `scan-time-warnings.ts` so `scan_project` emits the same warning
 * payload as `checklist` / `coverage` on identical input — the cross-
 * surface invariant the doctrine names. Empty list when the map is
 * absent or every detector-matching file produced findings.
 */
function computeInlineHtmlFileSamples(
  perFileSamples:
    | ReadonlyMap<
        string,
        readonly { readonly path: string; readonly line: number; readonly pattern: string }[]
      >
    | undefined,
  formattedFiles: readonly { readonly path: string; readonly findings: readonly unknown[] }[],
): readonly { readonly path: string; readonly line: number; readonly pattern: string }[] {
  if (perFileSamples === undefined || perFileSamples.size === 0) return [];
  const findingBearingPaths = new Set<string>();
  for (const f of formattedFiles) {
    if (f.findings.length > 0) findingBearingPaths.add(f.path);
  }
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
  readonly scanRoot?: string;
}): {
  readonly reviewCandidates?: readonly ScanProjectReviewCandidate[];
  readonly reviewCandidatePrompts?: Readonly<
    Record<string, import("./review-candidate-prompts.ts").ReviewCandidatePromptEntry>
  >;
} {
  const { formattedFilesCount, candidates, enabledStandards, session, files, limit, scanRoot } =
    args;
  // Gate 1: when automated findings exist, the agent already has
  // `file:line` pointers — it can choose to call `checklist` itself
  // for the manual half. Don't duplicate that surface (doctrine:
  // "Don't duplicate capability the agent already has").
  if (formattedFilesCount > 0) return {};
  if (candidates.length === 0) return {};
  const manualIds = collectManualCriteria(enabledStandards, session, session.config.level, files);
  const surfaced = buildScanProjectReviewCandidates({
    candidates,
    manualIds,
    limit,
    ...(scanRoot === undefined ? {} : { scanRoot }),
  });
  if (surfaced.length === 0) return {};
  // Cross-surface candidate-shape contract: emit
  // `reviewCandidatePrompts` alongside the surfaced rows so an agent
  // reading scan_project sees the same per-criterion shared-reason
  // dedup signal it would see on `scan_file.reviewCandidates` /
  // `checklist` / `review_candidates`. Per `docs/kb/architecture/ai-
  // first-consumer.md` "Per-tool review-candidate shape must agree
  // across surfaces" — and the per-criterion prompts axis is the
  // same shape on every surface that ships review candidates.
  // Present-when-meaningful per CLAUDE.md §1: an empty map is
  // omitted via the conditional spread below.
  const prompts = buildReviewCandidatePrompts({ candidates, manualIds });
  const promptsField = Object.keys(prompts).length === 0 ? {} : { reviewCandidatePrompts: prompts };
  return { reviewCandidates: surfaced, ...promptsField };
}

/**
 * enriches per-file entries
 * with a `limitations` field when the underlying `ParsedFile`'s
 * in-house parser emitted errors. The finding-bearing path is always
 * `partial_parse` (file is in `files[]` because it produced findings);
 * the classifier in {@link buildFileLimitation} uses `fileHasFindings:
 * true` to stamp the correct reason. Returns the input list unchanged
 * when no entry's source file carried parse errors — a hot path for
 * clean scans.
 *
 * Doctrine: CLAUDE.md §1 "Ambiguous field shapes are dishonest" —
 * omit the field on cleanly-parsed entries rather than ship `[]`. The
 * enrichment runs post-pagination + post-hoist so only files that
 * actually ship on this page pay the lookup cost.
 */
function attachPerFileLimitations(
  entries: readonly ScanFormatted["files"][number][],
  parsedFiles: readonly ParsedFile[],
): readonly ScanFormatted["files"][number][] {
  const parsedByPath = new Map<string, ParsedFile>();
  for (const pf of parsedFiles) {
    if (pf.ast.errors.length > 0) parsedByPath.set(pf.filePath, pf);
  }
  if (parsedByPath.size === 0) return entries;
  return entries.map((entry) => {
    const pf = parsedByPath.get(entry.path);
    if (pf === undefined) return entry;
    // `entry.findings.length > 0` by construction — only finding-bearing
    // files reach `formatted.files`. Threaded explicitly so the
    // classifier's contract stays honest at the call site.
    const limitation = buildFileLimitation(pf, entry.findings.length > 0);
    if (limitation === null) return entry;
    return { ...entry, limitations: [limitation] };
  });
}

/**
 * Builds the `scanned_build_artifacts_present` warning summary —
 * `{count, topPath?, top?}` — from the classifier's per-entry
 * verdicts. The agent uses the inline `top` head-slice (up to
 * {@link SCANNED_BUILD_ARTIFACTS_TOP_CAP}) to dismiss
 * vendor-and-vendor-only scans in one read by inspecting path +
 * classifier verdict together; without it, an agent reading the
 * bare code can't tell whether the scan included one stray
 * `dist/foo.min.css` or a 200-file vendor dump — two distinct
 * triage regimes with identical top-level shape. The full
 * per-path detail still lives in `meta.scannedBuildArtifacts`
 * (grouped + ungrouped) for entries beyond the top-N, gated
 * through the existing
 * {@link import("./meta-array-cap.ts").META_ARRAY_CAP} regime.
 * The `reason` is the per-entry classifier verdict
 * (`definite-min-infix`, `likely-vendor-distribution`, etc.)
 * lifted verbatim — no heuristic synthesis at the warnings seam
 * (per AI-first "Heuristic-mislabeled meta sub-fields are
 * dishonest"). Returns `undefined` when no entries were
 * classified; the warning code can still fire off the binary
 * `present` flag without a payload mirror.
 *
 * Extracted from {@link buildBaseWarningsForScanProject} so its
 * cognitive complexity stays inside the lint budget.
 */
function buildScannedBuildArtifactsSummary(entries: readonly ScannedBuildArtifact[]):
  | {
      readonly count: number;
      readonly topPath?: string;
      readonly top?: readonly {
        readonly path: string;
        readonly reason: BuildArtifactClassification;
      }[];
    }
  | undefined {
  if (entries.length === 0) return undefined;
  const top = entries
    .slice(0, SCANNED_BUILD_ARTIFACTS_TOP_CAP)
    .map((e) => ({ path: e.path, reason: e.classification }));
  return {
    count: entries.length,
    ...(entries[0]?.path === undefined ? {} : { topPath: entries[0].path }),
    ...(top.length === 0 ? {} : { top }),
  };
}

/**
 * assembly seam. Cross-references
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
  /**
   * Resolved scan root — drives the
   * `warningsDetails.no_config_found.searchedFrom` payload so every
   * project-rooted tool surfaces the same canonical "where did the
   * loader walk from" answer when no config resolved.
   */
  readonly root: string;
  readonly buildArtifacts: {
    readonly present: boolean;
    readonly entries: readonly ScannedBuildArtifact[];
    readonly vendorLibraries: readonly DetectedVendorLibrary[];
    readonly metaField: { readonly scannedBuildArtifacts?: BuildArtifactsGrouped };
  };
  readonly storybookPresetActive: boolean;
  readonly sessionWrappersMismatchCwd: boolean;
  readonly additionalPathsRedundant: boolean;
  /**
   * Q13-REDUNDANT-ADDITIONAL-PATHS-EMPTY-DETAILS: caller-supplied
   * subset of `additionalPaths` whose entries contributed parseable
   * files all already in the discovered base set — drives
   * `warningsDetails.redundant_additional_paths.redundantPaths`. Empty
   * list resolves to no payload (the bare-code signal still fires off
   * `additionalPathsRedundant`).
   */
  readonly redundantAdditionalPathsList: readonly string[];
  readonly restrictToPathsEmpty: boolean;
  readonly configSearchSawProjectMarker: boolean;
  readonly scssUnresolvedVariableFiles: readonly string[];
  readonly bulkCatalogDetection: BulkCatalogDetection | undefined;
  /** Count of dynamic innerHTML/insertAdjacentHTML template literals declined by the extractor. */
  readonly jsInnerHtmlDeclinedCount: number;
  /**
   * Per-file inline-HTML pattern detector samples. Cross-referenced
   * here against finding-bearing paths from `formatted.files` so the
   * warning payload's `fileSamples[]` only carries paths the routed
   * parser produced zero findings on.
   */
  readonly jsInnerHtmlPatternSamples?: ReadonlyMap<
    string,
    readonly { readonly path: string; readonly line: number; readonly pattern: string }[]
  >;
  /**
   * Per-file MDX code-demo prop matches. Drives the
   * `jsx_code_demo_prop_parsed_as_live_dom` warning. See
   * {@link import("./warnings.ts").WarningInputs.codeDemoPropMatches}
   * for the contract.
   */
  readonly codeDemoPropMatches?: import("./warnings.ts").WarningInputs["codeDemoPropMatches"];
  /**
   * Pre-computed cross-check for
   * `coverage_confidence_uniformly_high_with_parse_errors` (`true` when
   * every adjusted `perRuleCoverage` row is high confidence with no
   * `byFile` overrides). The warnings module pairs the boolean with the
   * parse-error count from `meta.analysisCoverage.parseErrorFileCount`
   * for the emission gate.
   */
  readonly perRuleCoverageUniformlyHigh: boolean;
}): {
  readonly baseWarnings?: readonly import("./warnings.ts").ScanWarningCode[];
  readonly baseWarningsDetails?: import("./warnings.ts").ScanWarningDetails;
} {
  const {
    formatted,
    parsedFiles,
    rootSource,
    configSource,
    root,
    buildArtifacts,
    storybookPresetActive,
    sessionWrappersMismatchCwd,
    additionalPathsRedundant,
    redundantAdditionalPathsList,
    restrictToPathsEmpty,
    configSearchSawProjectMarker,
    scssUnresolvedVariableFiles,
    bulkCatalogDetection,
    jsInnerHtmlDeclinedCount,
    jsInnerHtmlPatternSamples,
    codeDemoPropMatches,
    perRuleCoverageUniformlyHigh,
  } = args;
  const vendorCssNoise = computeVendorCssNoise(buildArtifacts.entries, formatted.files);
  // gate the `template_files_parsed_as_literal`
  // code on actual overlap between findings and directive lines —
  // see the code's doctrine comment in `src/mcp/warnings.ts`. Pull
  // `(filePath, line)` tuples out of every finding `formatted.files`
  // already grouped; cross-reference against per-file source text
  // indexed by `ParsedFile.filePath`.
  const templateOverlapResult = computeTemplateDirectiveOverlap({
    findings: formatted.files.flatMap((f) =>
      f.findings.map((fn) => ({ filePath: f.path, line: fn.line })),
    ),
    sourcesByPath: new Map(parsedFiles.map((f) => [f.filePath, f.source])),
  });
  const templateDirectivesOverlap = templateOverlapResult.overlap;
  // Combine the analysis-coverage accumulator's frontmatter-fence
  // file list (lifted onto `analysisCoverage.frontmatterFenceFiles`)
  // with the overlap-confirmed directive files so the warning's
  // `warningsDetails.template_files_parsed_as_literal.files` payload
  // names every file that contributed to the predicate.
  const templateLiteralFiles = combineTemplateLiteralFiles(
    formatted.meta["analysisCoverage"] as Record<string, unknown> | undefined,
    templateOverlapResult.overlapFiles,
  );
  // Per-style splits of the overlap-confirmed file list — drives the
  // `liquid_directives_unparsed` / `erb_directives_unparsed` /
  // `curly_double_directives_unparsed` per-style codes. Shared helper
  // applies the same fragment-classifier deduplication the parent
  // file list uses.
  const perStyleLiteralFiles = computePerStyleTemplateLiteralFiles(
    formatted.meta["analysisCoverage"] as Record<string, unknown> | undefined,
    templateOverlapResult.overlapByStyle,
  );
  const scannedBuildArtifactsSummary = buildScannedBuildArtifactsSummary(buildArtifacts.entries);
  // narrow the build-artifact
  // entries to the minified subset specifically. The classifier emits
  // two minified-shaped classifications (`definite-min-infix` for
  // `.min.` basenames — path-anchored — and
  // `likely-minified-by-line-stats` for the corroborated long-line
  // probe; see `src/mcp/build-artifacts.ts`); we filter on both because
  // the warning names "files whose findings are nearly always
  // unreliable because the source is minified bytes" and the same
  // triage applies whether the verdict is path-anchored or content-
  // shaped. Pairs with the broader `scanned_build_artifacts_present`
  // code (any classification); this finer code narrows to the two
  // minified-shaped branches specifically.
  const scannedMinifiedFiles = buildArtifacts.entries
    .filter(
      (e) =>
        e.classification === "definite-min-infix" ||
        e.classification === "likely-minified-by-line-stats",
    )
    .map((e) => e.path);
  // cross-reference the
  // banner-detected vendor libraries with per-rule per-file finding
  // counts. Empty when no vendor library was identified OR no
  // (ruleId, file) pair on a vendor library cleared the floor.
  const animationLibraryGuardCandidates = computeAnimationLibraryGuardCandidates({
    vendorLibraries: buildArtifacts.vendorLibraries,
    files: formatted.files,
  });
  // cross-reference the build-
  // artifact entry count against `meta.filesScanned`. When 100% of the
  // parsed files are classified as build artifacts AND the scan
  // touched at least one file, the `build_artifact_only_scan_detected` code
  // names the regime where the entire scan surface is generated bytes
  // — the doctrine analogue of `scanned_zero_files` for "tool ran on
  // nothing authored." The warnings helper stays pure over its
  // inputs; the predicate is computed once here.
  const filesScannedFromMeta = readMetaNumber(formatted.meta, "filesScanned");
  const scannedBuildArtifactsAllFiles =
    filesScannedFromMeta > 0 && buildArtifacts.entries.length === filesScannedFromMeta;
  const jsInnerHtmlFileSamplesForPayload = computeInlineHtmlFileSamples(
    jsInnerHtmlPatternSamples,
    formatted.files,
  );
  // Cross-reference parsed HTML inputs against
  // `<link rel="stylesheet" href="…">` references the contrast rule
  // does not consult during resolution. The detector is pure over the
  // parsed-file list; the warning channel surfaces the silent omission
  // per the AI-first "Routing skips that drop content are the symmetric
  // twin of suppression" doctrine.
  const linkedStylesheetsUnresolvedForContrast =
    detectLinkedStylesheetsNotResolvedForContrast(parsedFiles);
  // Collect `.js` files where the TSX parser bailed AND zero rules
  // fired against the file — actual content-drop evidence the doctrine
  // names. Drives `parser_bailed_on_non_jsx_in_tsx_route`. Same
  // predicate as the shared scan-time-warnings aggregator (extension +
  // parse-error + zero findings); extracted into a helper so the
  // orchestrator's cognitive complexity stays under the lint cap.
  const parserBailedJsTsxRouteFiles = collectParserBailedJsTsxRouteFiles(
    parsedFiles,
    formatted.files,
  );
  // Detect canonical vanilla-JS demo shell shapes — body has ≤3
  // non-script visible children, contains an empty `<div id>` (or
  // landmark-tagged equivalent), and has a sibling `<script src>`
  // referencing an external JS file. Drives
  // `dynamic_content_container_detected` per AI-first doctrine
  // "Zero-output success is ambiguous failure": without this code, a
  // runtime-render shell page returns zero findings and reads as
  // "clean page" when the truthful answer is "static scan cannot
  // evaluate runtime-generated DOM."
  const dynamicContentContainerEntries = detectDynamicContentContainers(parsedFiles);
  const warningsFromMeta = warningsFieldFromScanMeta({
    meta: formatted.meta,
    rootSource,
    configSource,
    // Surface the loader's search root on
    // `warningsDetails.no_config_found.searchedFrom` so every
    // project-rooted tool answers "where was the search?" the same way.
    // Threaded through here regardless of the gate predicate; the
    // summarizer drops the payload when the code itself didn't fire.
    configSearchedFromForWarning: root,
    // Present-when-meaningful gate on
    // `warningsDetails.no_config_found.searchedFrom`: `root` IS the
    // resolved `scanned.root` shipped on the response. When the gate
    // fires (the search base would just echo `meta.scanned.root`), the
    // rich `{ searchedFrom }` payload drops to `{}` so the bare warning
    // code is the canonical signal — see `scanner-meta.ts`'s
    // {@link noConfigFoundWarningDetail} for the predicate.
    noConfigFoundScannedRoot: root,
    scannedBuildArtifactsPresent: buildArtifacts.present,
    ...(scannedBuildArtifactsSummary === undefined ? {} : { scannedBuildArtifactsSummary }),
    ...(scannedBuildArtifactsAllFiles ? { scannedBuildArtifactsAllFiles: true } : {}),
    storybookPresetActive,
    sessionWrappersMismatchCwd,
    templateDirectivesOverlap,
    ...templateLiteralFilesField(templateLiteralFiles),
    ...perStyleLiteralFilesField(perStyleLiteralFiles),
    additionalPathsRedundant,
    ...(redundantAdditionalPathsList.length > 0 ? { redundantAdditionalPathsList } : {}),
    restrictToPathsEmpty,
    configSearchSawProjectMarker,
    // Q-SHARED-META-ARRAY-BUDGET-CAP: scan-project is the primary
    // driver of meta-array bloat (CSS build-artifact tails, parse-
    // error dumps on bulk-template repos). We look at the assembled
    // meta directly — including the `scannedBuildArtifacts`
    // sub-object the caller just mixed in — so every capped array
    // in scope is covered. Pure over the assembled meta; no
    // duplicated predicate at each cap call site.
    metaArrayTruncatedFields: getTruncatedMetaArrayFields({
      ...formatted.meta,
      ...buildArtifacts.metaField,
    }),
    ...(vendorCssNoise === undefined ? {} : { vendorCssNoise }),
    ...(scssUnresolvedVariableFiles.length === 0 ? {} : { scssUnresolvedVariableFiles }),
    ...(scannedMinifiedFiles.length === 0 ? {} : { scannedMinifiedFiles }),
    // detector ran upstream at the
    // call site (it needs `meta.durationMs` + `meta.filesScanned` +
    // the build-artifact entries) and resolved to either an
    // additive payload or `undefined`. Conditional-spread keeps the
    // shape honest per CLAUDE.md §1 "Ambiguous field shapes are
    // dishonest" — the warning code drops conservatively when the
    // detector did not fire.
    ...(bulkCatalogDetection === undefined ? {} : { bulkCatalogDetection }),
    ...(animationLibraryGuardCandidates.length === 0 ? {} : { animationLibraryGuardCandidates }),
    // thread the innerHTML declined count so the warnings module can
    // fire `js_innerhtml_template_literal_unparsed` when dynamic
    // template literals were detected but not parsed.
    ...(jsInnerHtmlDeclinedCount > 0 ? { jsInnerHtmlDeclinedCount } : {}),
    // cross-reference the per-file pattern detector samples with the
    // finding-bearing path set so the warning's `fileSamples` payload
    // names only paths the routed parser produced zero findings on
    // (the routing-skip failure mode the doctrine names). Per-file
    // detector emits up to N samples; we keep one representative per
    // file so the wire payload scales with file count rather than raw
    // pattern instances. Empty list resolves to no payload.
    ...(jsInnerHtmlFileSamplesForPayload.length === 0
      ? {}
      : { jsInnerHtmlFileSamples: jsInnerHtmlFileSamplesForPayload }),
    ...codeDemoPropMatchesField(codeDemoPropMatches),
    // detector ran upstream on the
    // parsed-file list; conditional-spread keeps the input absent when
    // no HTML file declared an unresolved `<link rel="stylesheet">`.
    ...(linkedStylesheetsUnresolvedForContrast.localUnresolvedHrefCount === 0 &&
    linkedStylesheetsUnresolvedForContrast.externalCdnHrefCount === 0 &&
    linkedStylesheetsUnresolvedForContrast.templateExpressionHrefCount === 0
      ? {}
      : { linkedStylesheetsUnresolvedForContrast }),
    // thread the total finding count
    // so the warnings module can fire `parser_bailed_zero_findings`
    // on the canonical "parse errors present + zero findings overall"
    // shape. Computed by summing per-file findings off `formatted.files`
    // — `plan.totalFindings` was deliberately removed (composite
    // headline doctrine) so the value is not on `meta` and we
    // accumulate locally instead.
    totalFindings: formatted.files.reduce((acc, f) => acc + f.findings.length, 0),
    // Surface the `.js` → tsx routing decision when actual bail
    // evidence is present (parse errors + zero findings on the file).
    // Drives `parser_bailed_on_non_jsx_in_tsx_route` and its
    // `warningsDetails.<code>.files` payload. Conditional-spread keeps
    // the input absent when no `.js` file met the conjunction so the
    // warning predicate drops conservatively per the doctrine bullet
    // "Empty `warningsDetails.<code>: {}` is dishonest."
    ...(parserBailedJsTsxRouteFiles.length === 0 ? {} : { parserBailedJsTsxRouteFiles }),
    // Surface the runtime-render-shell shape when the detector
    // matched at least one HTML page. Drives
    // `dynamic_content_container_detected` and its
    // `warningsDetails.<code>.files` payload. Conditional-spread per
    // present-when-meaningful: empty list omits the field so the
    // warning predicate drops conservatively (no payload, no code).
    ...dynamicContentContainerEntriesField(dynamicContentContainerEntries),
    // pre-computed cross-check for
    // `coverage_confidence_uniformly_high_with_parse_errors`. The
    // warning fires only when this boolean is `true` AND
    // `meta.analysisCoverage.parseErrorFileCount > 0` — names the
    // consistency gap between the parse-error surface and the per-rule
    // coverage surface.
    ...(perRuleCoverageUniformlyHigh ? { perRuleCoverageUniformlyHighWithParseErrors: true } : {}),
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
/**
 * Builds the spreadable `templateLiteralFiles` subset for the
 * `warningsFieldFromScanMeta` call. Conditional-spread per the
 * present-when-meaningful contract: empty list omits the field, non-
 * empty carries the path list. Drives the
 * `warningsDetails.template_files_parsed_as_literal: { files, extensions }`
 * payload at the warnings-module seam.
 */
function templateLiteralFilesField(files: readonly string[]): {
  templateLiteralFiles?: readonly string[];
} {
  return files.length === 0 ? {} : { templateLiteralFiles: files };
}

/**
 * Builds the spreadable `codeDemoPropMatches` subset for the
 * `warningsFieldFromScanMeta` call. Conditional-spread per the
 * present-when-meaningful contract: empty / undefined map omits the
 * field; non-empty threads the matches map through unchanged.
 * Extracted from {@link buildBaseWarningsForScanProject} so the
 * orchestrator's cognitive complexity stays under the lint cap.
 */
function codeDemoPropMatchesField(
  matches: import("./warnings.ts").WarningInputs["codeDemoPropMatches"],
): {
  codeDemoPropMatches?: import("./warnings.ts").WarningInputs["codeDemoPropMatches"];
} {
  if (matches === undefined || matches.size === 0) return {};
  return { codeDemoPropMatches: matches };
}

/**
 * Builds the {@link CorpusWarningFiles} array consumed by the per-FILE
 * propagation pass on per-finding `couldBeWrongBecause`. Each entry
 * pairs one corpus-level warning code with the file-path set the
 * warning's evidence model named, so the per-finding helper can append
 * the code (and downgrade confidence one step) on every finding whose
 * hosting file is in the named set.
 *
 * Currently sources one warning — `jsx_code_demo_prop_parsed_as_live_dom`
 * (file paths drawn from the same map that drives the corpus-level
 * warning at the warnings module). Other warnings carrying file lists
 * (`dynamic_content_container_detected`,
 * `parser_bailed_on_non_jsx_in_tsx_route`,
 * `linked_stylesheet_local_unresolved`) can opt in by appending to the
 * returned array. Each entry is independent — the per-finding helper
 * propagates them all in a single pass.
 *
 * Returns an empty array when none of the wired warnings fired on this
 * scan; the per-finding helper's no-op fast path keeps the common case
 * cheap.
 */
function buildCorpusWarningFilesForScanProject(
  codeDemoPropMatches: import("./warnings.ts").WarningInputs["codeDemoPropMatches"],
): readonly CorpusWarningFiles[] {
  const out: CorpusWarningFiles[] = [];
  if (codeDemoPropMatches !== undefined && codeDemoPropMatches.size > 0) {
    const files = new Set<string>();
    for (const [path, matches] of codeDemoPropMatches) {
      if (matches.length > 0) files.add(path);
    }
    if (files.size > 0) {
      out.push({ warningCode: "jsx_code_demo_prop_parsed_as_live_dom", files });
    }
  }
  return out;
}

/**
 * Builds the spreadable `dynamicContentContainerEntries` subset for the
 * `warningsFieldFromScanMeta` call. Conditional-spread per the
 * present-when-meaningful contract: empty list omits the field so the
 * warning code drops conservatively. Extracted from
 * {@link buildBaseWarningsForScanProject} so the orchestrator's
 * cognitive complexity stays under the lint cap (mirrors the existing
 * `codeDemoPropMatchesField` / `templateLiteralFilesField` helpers).
 */
function dynamicContentContainerEntriesField(
  entries: import("./warnings.ts").WarningInputs["dynamicContentContainerEntries"],
): {
  dynamicContentContainerEntries?: import("./warnings.ts").WarningInputs["dynamicContentContainerEntries"];
} {
  if (entries === undefined || entries.length === 0) return {};
  return { dynamicContentContainerEntries: entries };
}

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

// `computeVendorCssNoise` and `computeAnimationLibraryGuardCandidates`
// were extracted to `./scan-time-warnings.ts` so `tool-checklist` and
// `tool-coverage` can compute the same scan-time warning channel
// without duplicating predicates. `scan-time-warnings.ts`
// re-exports them; `tool-scan-project` consumes via the import above.

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
  const base = configSourcePath === null ? root : posixDirname(configSourcePath);
  // POSIX-normalize the resolved page paths so they compare on the same
  // separator as `ProjectFile.filePath` (the discovery walker emits
  // POSIX absolute paths even on Windows). Without normalization,
  // `path.resolve` returns native (backslash) on Windows, which the
  // process-aware finders' `fileByAbsPath.get(pagePath)` lookup misses.
  return processes.map((p) => ({
    ...p,
    pages: p.pages.map((pagePath) =>
      (isAbsolute(pagePath) ? pagePath : posixResolve(base, pagePath)).split(/[\\/]/).join("/"),
    ),
  }));
}

/**
 * One-hop AST probe: when autoDetect is on, split detected
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
 * Bundles the autoDetect-flag + config-missing predicate pair and
 * the resulting wrapper-candidate / classified outputs into one
 * helper. Extracted from the handler so its cognitive-complexity
 * score stays inside the lint budget — the original inline form
 * carried two branches (`autoDetect || configMissing`, the ternary
 * gating `collectWrapperCandidates`) that pushed the handler over the
 * cap once `summaryOnly` added one more divert.
 *
 * The detector runs whenever `autoDetect: true` OR config is missing
 * — the latter so `meta.autoDetectedWrappers` populates on
 * first-run codebases where the agent hasn't pasted a `ra11y.config.ts`
 * yet (the most common field-report scope). Registration into the
 * scan-time native-wrapper set still gates on `autoDetect === true`
 * (see {@link classifyIfAutoDetect}'s early-return); the missing-config
 * branch produces suggestion-only output that surfaces under
 * `meta.autoDetectedWrappers` for the agent to copy.
 */
function resolveWrapperDetection(args: {
  readonly params: Record<string, unknown>;
  readonly projectConfig: import("../types/config.ts").LoadedConfig;
  readonly files: readonly ParsedFile[];
}): {
  readonly autoDetect: boolean;
  readonly configMissing: boolean;
  readonly detectedNames: readonly string[];
  readonly classified: {
    readonly confirmed: readonly string[];
    readonly assumed: readonly string[];
  };
} {
  const autoDetect = args.params["autoDetectWrappers"] === true;
  const configMissing = args.projectConfig.sourcePath === null;
  const shouldDetect = autoDetect || configMissing;
  const detected = shouldDetect ? collectWrapperCandidates(args.files) : [];
  const detectedNames = detected.map((c) => c.component);
  const classified = classifyIfAutoDetect(autoDetect, args.files, detectedNames);
  return { autoDetect, configMissing, detectedNames, classified };
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
 *   - `autoDetectedWrappers: { ran: true, candidates: [...] }` + note:
 *     registered for this scan (flag on). The object form is honest
 *     under "Ambiguous field shapes are dishonest" — `ran: true` carries
 *     the "detector executed" signal independent of how many candidates
 *     it found, so an empty `candidates: []` is unambiguous ("ran and
 *     found nothing"), distinguishable from the field's complete absence
 *     ("detector did not run").
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
      autoDetectedWrappers: { ran: true, candidates: detectedNames },
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
 * Layered nextStep override for the bulk-vendor regime: when the
 * corpus carries enough build-artifact basename groups AND
 * files-with-findings to tell us the structural fix is
 * `ra11y.config.ts` `exclude` (not `suggest_fix` on a vendor finding),
 * replaces `baseNextStep` with the scope-down hint.
 *
 * The helper threads through `buildArtifacts` rather than reading the
 * fully-assembled `meta.scannedBuildArtifacts` so the predicate stays
 * close to its inputs — the caller has both pieces in hand at the
 * `buildNextStep` call site, and reaching back into `meta` would
 * couple the override on field-naming the assembler owns. Returns
 * `baseNextStep` unchanged when the predicate fails so the standard
 * routing wins on every non-bulk-vendor scan (small repos, vendor-
 * free corpora, vendor-light scans where suggest_fix is the right
 * first call).
 *
 * Per the AI-first doctrine "NextStep prioritization on
 * truncated/bulk responses must avoid first-by-filename routing,"
 * generalized one axis: even when no truncation fires, a corpus whose
 * shape is dominated by vendor groups belongs in a config-level scope-
 * down lane rather than the per-finding `suggest_fix` lane. The
 * findings under those vendor basenames still ship in `files[]`
 * (surface-don't-suppress); the override only changes the canonical
 * first call.
 *
 * When the override fires AND a dominant non-vendor top-level
 * directory can be derived from the `files[]` inventory (the inverse
 * of the `suggestedExcludes` / `pathHint` vendor classification), the
 * structured target advances from the multi-step
 * `propose_config` → re-scan flow to the direct `scan_project`
 * `restrictToPaths: [<dir>]` re-scan. The prose still names both
 * options (config-level exclude OR scope narrowing) so the agent
 * keeps full flexibility; the structured args advance the directly-
 * actionable narrower call. This addresses the suggestedExcludes-not-
 * additionalPaths-inverse asymmetry: `suggestedExcludes` is shaped
 * for a config-file edit, but the structured next-call should reflect
 * the more direct lever (re-scan with narrower scope) when the
 * scanner has the evidence to pick one. When no clear dominant non-
 * vendor dir exists (every top dir is vendor, the inventory is empty,
 * or the top-dir tally ties), the override degrades to the existing
 * `propose_config` route honestly — fabricating a narrowing dir on
 * weaker evidence is the symmetric twin of heuristic suppression.
 */
export function applyBulkVendorScopeDownOverride(args: {
  readonly baseNextStep: { readonly prose: string; readonly structured?: NextStepStructured };
  readonly buildArtifacts: {
    readonly metaField: { readonly scannedBuildArtifacts?: BuildArtifactsGrouped };
  };
  readonly totalFilesWithFindings: number;
  /**
   * Per-file finding inventory (full or paged — both work). Drives the
   * "promote `propose_config` route → direct `scan_project`
   * `restrictToPaths` re-scan" structured-target promotion when a
   * dominant non-vendor top-level dir can be derived. Optional so tests
   * that exercise the predicate alone (without an inventory) keep the
   * existing `propose_config` fallback shape; production call sites
   * always thread the inventory through.
   */
  readonly files?: readonly ScanFormatted["files"][number][];
}): { readonly prose: string; readonly structured?: NextStepStructured } {
  const { baseNextStep, buildArtifacts, totalFilesWithFindings, files = [] } = args;
  const grouped = buildArtifacts.metaField.scannedBuildArtifacts?.grouped ?? [];
  if (
    !shouldRerouteToBulkVendorScopeDown({
      groupedCount: grouped.length,
      totalFilesWithFindings,
    })
  ) {
    return baseNextStep;
  }
  const overridden = bulkVendorScopeDownNextStep({
    topGroupHints: grouped.map((g) => ({
      basename: g.basename,
      count: g.count,
      suggestedGlob: g.suggestedGlob,
    })),
    groupedTotal: grouped.length,
    totalFilesWithFindings,
  });
  // Promote the structured target from `propose_config` → re-scan to
  // the direct `scan_project` re-scan when a dominant non-vendor top-
  // level directory can be derived. The prose is unchanged — it
  // already names both levers; the agent reads the structured field
  // to advance directly. The `propose_config` fallback stays when no
  // narrowing target is honestly derivable.
  const isVendor = buildVendorPredicate({
    scannedBuildArtifacts: buildArtifacts.metaField.scannedBuildArtifacts,
  });
  const narrowing = pickNonVendorNarrowingDir(files, isVendor);
  if (narrowing === undefined) return overridden;
  return {
    prose: overridden.prose,
    structured: { tool: "scan_project", args: { restrictToPaths: [narrowing] } },
  };
}

/**
 * Layered nextStep override for the `small_demo_catalog` regime: when
 * the bulk-catalog detector classified the corpus as a parallel-
 * sibling-subprojects layout (≥30 sibling subdirs sharing the same
 * per-dir basename signature, no vendor-classified files), proposes
 * `groupBy: "firstChildDir"` as the canonical narrowing path. The
 * catalog shape IS the canonical case for that aggregator: one whole-
 * tree scan with per-sub-project rollup beats N round-trips with
 * `additionalPaths` per sub-project AND beats paging through `files[]`
 * file-by-file.
 *
 * Per the AI-first doctrine "One tool call should answer 'what
 * next?'", the override ensures `nextStepStructured` names the
 * alternative narrowing path explicitly so the agent never has to
 * discover the existing `groupBy` capability out-of-band.
 *
 * Skipped when:
 *   - The detector didn't fire `small_demo_catalog` (no bulk-catalog
 *     detection at all, or the vendor-heavy paths fired instead — the
 *     `applyBulkVendorScopeDownOverride` already handles those).
 *   - The caller already passed a `groupBy` parameter (proposing the
 *     same value would echo their own input; proposing a different
 *     one would be presumptuous).
 *   - The bulk-vendor override already replaced the structured target
 *     (vendor exclude is the first lever per `bulk-catalog.ts`
 *     precedence). Detected by checking whether `baseNextStep`'s
 *     structured `tool` field is `propose_config` (the bulk-vendor
 *     fallback) — if it is, the agent's first lever is the config
 *     emit, not the groupBy proposal.
 *
 * Returns `baseNextStep` unchanged on every skip path so the
 * downstream assembly carries the standard hint untouched.
 */
export function applySmallDemoCatalogGroupByOverride(args: {
  readonly baseNextStep: NextStepResult;
  readonly bulkCatalogDetection: BulkCatalogDetection | undefined;
  readonly callerGroupBy: string | undefined;
  readonly cwd: string;
}): NextStepResult {
  const { baseNextStep, bulkCatalogDetection, callerGroupBy, cwd } = args;
  if (bulkCatalogDetection?.trigger !== "small_demo_catalog") return baseNextStep;
  if (callerGroupBy !== undefined) return baseNextStep;
  // The bulk-vendor override routes the agent at `propose_config` for
  // the structural exclude — when that fires, the catalog shape may
  // still look small-demo on the file-shape axis, but the vendor
  // footprint dominates the routing. Defer to the bulk-vendor lane.
  if (baseNextStep.structured?.tool === "propose_config") return baseNextStep;
  const siblingShape = bulkCatalogDetection.siblingShape;
  if (siblingShape === undefined) return baseNextStep;
  return smallDemoCatalogGroupByNextStep({
    siblingCount: siblingShape.siblingCount,
    signature: siblingShape.signature,
    exampleSiblings: siblingShape.exampleSiblings,
    cwd,
  });
}

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
/**
 * Up-front type validation for `scan_project` boolean / string-array
 * params. Closes the silent-drop class for this handler: a caller that
 * sends `autoDetectWrappers: "true"` (string), `additionalPaths: "src"`
 * (single string instead of array), or `verboseMeta: 1` (number) used
 * to slip past the loose `=== true` / `Array.isArray` guards and the
 * response shape echoed defaults — indistinguishable from "I never
 * asked." Mirrors the closure pattern `configure-opts.ts.allowWrite`
 * shipped for `sessionConfigure`. Range checks (`limit`, `offset`)
 * stay at their existing call sites; this helper enforces type honesty
 * only.
 */
function validateScanProjectParamTypes(
  params: Record<string, unknown>,
): StructuredError | undefined {
  const autoDetect = requireBooleanParam(params, "autoDetectWrappers");
  if (!autoDetect.ok) return autoDetect.error;
  const verboseMeta = requireBooleanParam(params, "verboseMeta");
  if (!verboseMeta.ok) return verboseMeta.error;
  const collapseByGroup = requireBooleanParam(params, "collapseByGroupKey");
  if (!collapseByGroup.ok) return collapseByGroup.error;
  const summaryOnly = requireBooleanParam(params, "summaryOnly");
  if (!summaryOnly.ok) return summaryOnly.error;
  const changedOnly = requireBooleanParam(params, "changedOnly");
  if (!changedOnly.ok) return changedOnly.error;
  const includeReferenceGuide = requireBooleanParam(params, "includeReferenceGuide");
  if (!includeReferenceGuide.ok) return includeReferenceGuide.error;
  const additionalPaths = requireStringArrayParam(params, "additionalPaths");
  if (!additionalPaths.ok) return additionalPaths.error;
  const restrictToPaths = requireStringArrayParam(params, "restrictToPaths");
  if (!restrictToPaths.ok) return restrictToPaths.error;
  const skipCriterion = requireStringArrayParam(params, "skipCriterion");
  if (!skipCriterion.ok) return skipCriterion.error;
  return undefined;
}

/**
 * Compose the up-front validation channels into one call site so the
 * handler keeps a single early-return. Combines the param-type check
 * with the existing `checkCwdExists` envelope; either branch produces
 * a {@link McpToolResult} the handler returns directly.
 */
function scanProjectEarlyValidation(
  params: Record<string, unknown>,
  explicitCwd: string | undefined,
): McpToolResult | undefined {
  const paramTypeError = validateScanProjectParamTypes(params);
  if (paramTypeError !== undefined) return errorResult(paramTypeError);
  const cwdError = checkCwdExists(explicitCwd);
  return cwdError === null ? undefined : cwdError;
}

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
  /**
   * when the empty-files branch is
   * reached because the caller's `restrictToPaths` intersected the
   * non-empty discovered set down to zero, the meta payload + warning
   * code must still ride on the response — otherwise the empty result
   * reads as a clean codebase scan (CLAUDE.md §1 "Zero-output success
   * is ambiguous failure"). The handler computes the restrict-applied
   * record at the call site and threads it through.
   */
  readonly restrictAppliedField: { readonly restrictToPathsApplied?: RestrictApplied };
  readonly restrictToPathsEmpty: boolean;
  /**
   * absolute path of the
   * nearest strict ancestor of `root` carrying a `ra11y.config.*` /
   * `package.json` marker, or `undefined` when no ancestor qualifies.
   * Drives the `cwd_appears_misrooted` warning; threaded as an explicit
   * input from the call site so the warnings helper stays pure.
   */
  readonly nearestConfigAncestor: string | undefined;
}) {
  const { root, actualMode, fallbackReason, rootSource, configSource } = args;
  return textResult({
    // drop the flat `violations: 0` headline
    // — see `buildScanPlan` in `scan-assembly.ts` for the full rationale.
    // Zero-files scan has no lanes to populate, so only
    // `infoSeverityFindings` and `summary` ride; callers sum
    // `plan.fixesByClass` for the flat count.
    plan: { infoSeverityFindings: 0, summary: "No parseable files found." },
    files: [],
    meta: {
      filesScanned: 0,
      scanned: scannedProject(root),
      scanMode: actualMode,
      ...(fallbackReason === undefined ? {} : { fallbackReason }),
      // zero-parseable-files on an SSG root is
      // canonically "all the markup lives in fragments the scanner
      // doesn't parse." Surface the framework + hint so the agent has
      // the build command and emit dir inline.
      ...mergeEmptyResultHints(ssgEmptyResultMetaFields(root), catalogEmptyResultMetaFields(root)),
      ...args.restrictAppliedField,
    },
    // Zero parsed files → the `no_config_found` warning drops by
    // construction via the `filesScanned < 10` gate; the probe flag is
    // threaded through for shape consistency but the warnings helper
    // will see filesScanned: 0 and never emit the code here.
    ...warningsField({
      filesScanned: 0,
      rootSource,
      configSource,
      configSearchedFromForWarning: root,
      // Present-when-meaningful gate on
      // `warningsDetails.no_config_found.searchedFrom`: `root` IS the
      // resolved `scanned.root` shipped on this response, so when the
      // gate fires the rich payload drops to `{}` (the bare code
      // remains the signal; `meta.scanned.root` carries the search
      // base). Threaded for shape consistency even though the predicate
      // gate drops `no_config_found` here by construction.
      noConfigFoundScannedRoot: root,
      analysisCoverage: undefined,
      filesByExtension: undefined,
      configSearchSawProjectMarker: args.configSearchSawProjectMarker,
      ...(args.restrictToPathsEmpty ? { restrictToPathsEmpty: true } : {}),
      // thread the strict-
      // ancestor probe result. The warnings helper fires the code only
      // when the field is a non-empty string; absence drops the code
      // and `scanned_zero_files` stays the honest signal.
      ...(args.nearestConfigAncestor === undefined
        ? {}
        : { nearestConfigAncestor: args.nearestConfigAncestor }),
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
 * type guards. Post the hints are
 * `{ code, text, detail? }` objects; the filter keeps only entries
 * that expose a string `code` so hostile shapes can't flow through.
 */
function readHintsArray(fragment: Record<string, unknown>): readonly Hint[] {
  const coverage = fragment["analysisCoverage"];
  if (typeof coverage !== "object" || coverage === null) return [];
  const hintsRaw = (coverage as Record<string, unknown>)["hints"];
  if (!Array.isArray(hintsRaw)) return [];
  return hintsRaw.filter((h): h is Hint => {
    if (h === null || typeof h !== "object") return false;
    const record = h as Record<string, unknown>;
    return typeof record["code"] === "string" && typeof record["text"] === "string";
  });
}

/**
 * Lifts the two corpus-evidence flags the SSG detector consumes off
 * the formatted meta block. The meta payload already carries
 * `analysisCoverage.hasFrontmatterFence` (set by the per-file
 * accumulator on every parsed HTML-family file whose source opens
 * with `^---\n…\n---\n`) and
 * `analysisCoverage.templateInterpolationFound[]` (per-token
 * occurrence counts including Liquid `{%x%}` / ERB `<%x%>` literals).
 * A separate `analysisCoverage.erbIslandsUnrendered` boolean fires
 * when a parsed `.erb` file carried an island opener — that flag is
 * a second route to the Liquid/ERB signal and OR's into the same
 * gate.
 *
 * Returns `undefined` when the meta block has no `analysisCoverage`
 * sub-object (file-mode scans, mocked envelopes) so the SSG detector
 * call site can pass through unconditionally — `detectSsgFramework`
 * treats `undefined` evidence as "no corpus signals available" and
 * the sentinelless Jekyll path falls back to dir-corroborators only.
 *
 * Pure over its input; no I/O. Lives next to {@link readHintsArray}
 * because both helpers extract a focused sub-shape off the same
 * `analysisCoverage` payload, and co-locating keeps the lifting
 * patterns visible at one site.
 */
function ssgCorpusEvidenceFromMeta(
  meta: Record<string, unknown>,
): import("./ssg-detect.ts").SsgCorpusEvidence | undefined {
  const coverage = meta["analysisCoverage"];
  if (typeof coverage !== "object" || coverage === null) return undefined;
  const record = coverage as Record<string, unknown>;
  const hasFrontmatterFence = record["hasFrontmatterFence"] === true;
  const hasLiquidOrErbTokens =
    record["erbIslandsUnrendered"] === true ||
    templateInterpolationContainsLiquidOrErb(record["templateInterpolationFound"]);
  if (!(hasFrontmatterFence || hasLiquidOrErbTokens)) return undefined;
  return {
    ...(hasFrontmatterFence ? { hasFrontmatterFence: true } : {}),
    ...(hasLiquidOrErbTokens ? { hasLiquidOrErbTokens: true } : {}),
  };
}

/**
 * True when `analysisCoverage.templateInterpolationFound[]` carries
 * an entry whose `token` literal is `{%x%}` (Liquid / Jinja
 * control-block) or `<%x%>` (ERB / EJS scriptlet). These literals are
 * higher-confidence Jekyll/Ruby substrate signals than `{{x}}` (bare
 * interpolation), which is shared with Handlebars / Mustache / Vue /
 * Angular and would mis-label non-Jekyll corpora.
 *
 * Pure helper extracted from {@link ssgCorpusEvidenceFromMeta} so the
 * parent stays inside the noComplexity lint cap. Tolerant of hostile
 * shapes — hands back `false` rather than throwing on anything that
 * isn't an array of `{ token: string }`-shaped records.
 */
function templateInterpolationContainsLiquidOrErb(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  for (const entry of input) {
    if (entry === null || typeof entry !== "object") continue;
    const tokenRaw = (entry as Record<string, unknown>)["token"];
    if (tokenRaw === "{%x%}" || tokenRaw === "<%x%>") return true;
  }
  return false;
}

/**
 * predicate. Returns true when the
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
 * Q13-REDUNDANT-ADDITIONAL-PATHS-EMPTY-DETAILS: derives the per-input
 * subset of `additionalPaths` that contributed parseable files
 * already in the discovered base set — i.e. the redundant subset, as
 * opposed to entries rejected for one of the per-path skip reasons
 * (`not-found` / `unsupported-extension` / `excluded-by-glob` /
 * `no-parseable-files`, all of which surface separately under
 * `meta.additionalPathsScanned.skipped[]`).
 *
 * The classifier owns the per-path skip predicate; the redundant set
 * is its complement within the input array. Returns an empty list when
 * no input was supplied. The summarizer drops the payload conservatively
 * when the list is empty so the warning channel's bare-code signal
 * still fires off `additionalPathsRedundant` even when the per-path
 * cross-reference is unavailable.
 *
 * Pure over its inputs — re-uses the same {@link classifyAdditionalPathSkips}
 * the meta-field builder consumed; the duplicate call is cheap (the
 * classifier walks the disk once per path with a 500-file cap) and
 * keeps the redundant-path derivation honest about which entries the
 * scan classifier saw as skipped.
 */
function redundantAdditionalPathsListFor(args: {
  readonly additionalPaths: readonly string[];
  readonly root: string;
  readonly excludes: readonly string[];
}): readonly string[] {
  if (args.additionalPaths.length === 0) return [];
  const skipped = classifyAdditionalPathSkips(args.additionalPaths, args.root, args.excludes);
  const skippedSet = new Set(skipped.map((s) => s.path));
  return args.additionalPaths.filter((p) => !skippedSet.has(p));
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
 * intersects a discovered file set
 * with the caller's `restrictToPaths`. A file is kept when ANY
 * restriction path either equals it (file-level restriction) OR is a
 * directory that contains it (directory prefix match). Restriction
 * paths resolve against `root` so callers can pass them in the same
 * shape they pass `cwd`-relative paths elsewhere — `["src/app"]`
 * works the same way `cwd: "src/app"` would scope a fresh scan, but
 * without forcing the agent to choose between paging-aware
 * `scan_project` and the alternative `scan` tool.
 *
 * Directory matching is `startsWith(restrictDir + sep)` — the trailing
 * separator gates `src/app/foo.tsx` against a stray match on a sibling
 * directory like `src/app-utils/`. File matching uses exact equality
 * because the discovery walker stamps files with their absolute paths.
 *
 * Empty `restrictToPaths` is the no-op shape; the caller short-circuits
 * before invoking this helper, so the function assumes ≥1 entry.
 */
function intersectFilesWithRestrictPaths<T extends { readonly filePath: string }>(
  files: readonly T[],
  restrictToPaths: readonly string[],
  root: string,
): readonly T[] {
  // POSIX-normalize the resolved restrict paths so they compare on the
  // same separator as `f.filePath` — the discovery walker now emits
  // forward-slash absolute paths even on Windows, but `path.resolve`
  // returns native (backslash) form there.
  const absRestricts = restrictToPaths.map((p) =>
    (isAbsolute(p) ? p : posixResolve(root, p)).split(/[\\/]/).join("/"),
  );
  return files.filter((f) => {
    for (const r of absRestricts) {
      if (f.filePath === r) return true;
      if (f.filePath.startsWith(`${r}/`)) return true;
    }
    return false;
  });
}

/**
 * entry point. Reads
 * `restrictToPaths` off the caller's params and either returns the
 * input set unchanged (no restriction supplied) or returns the
 * intersection plus the `restrictToPathsApplied` meta payload. Lives
 * in its own helper so the handler's cognitive-complexity score stays
 * inside the lint cap — the conditional-binding pattern was the
 * single edit that pushed it over.
 */
interface RestrictApplied {
  readonly paths: readonly string[];
  readonly filesBeforeRestrict: number;
  readonly filesAfterRestrict: number;
}

function applyRestrictToPaths<T extends { readonly filePath: string }>(
  params: Record<string, unknown>,
  mergedFiles: readonly T[],
  root: string,
): {
  readonly files: readonly T[];
  readonly restrictApplied: RestrictApplied | undefined;
  readonly restrictAppliedField: { readonly restrictToPathsApplied?: RestrictApplied };
} {
  const restrictToPaths = strArrayParam(params, "restrictToPaths") ?? [];
  if (restrictToPaths.length === 0) {
    return { files: mergedFiles, restrictApplied: undefined, restrictAppliedField: {} };
  }
  const intersected = intersectFilesWithRestrictPaths(mergedFiles, restrictToPaths, root);
  const restrictApplied: RestrictApplied = {
    paths: restrictToPaths,
    filesBeforeRestrict: mergedFiles.length,
    filesAfterRestrict: intersected.length,
  };
  return {
    files: intersected,
    restrictApplied,
    restrictAppliedField: { restrictToPathsApplied: restrictApplied },
  };
}

/**
 * Drives the `restrict_to_paths_no_matches` warning. Returns true only
 * when the restriction filter ran AND emptied a previously-non-empty
 * set — the ambiguous case where a successful zero-files response would
 * otherwise read as "clean codebase" rather than "the scope filter
 * rejected everything." Returns false when no restriction was supplied,
 * the restriction kept ≥1 file, OR the pre-restrict set was already
 * empty (that case is `scanned_zero_files`, not the restriction).
 * Extracted so the handler's cognitive-complexity score stays inside
 * the lint cap.
 */
function didRestrictToPathsEmptyTheSet(applied: RestrictApplied | undefined): boolean {
  if (applied === undefined) return false;
  return applied.filesBeforeRestrict > 0 && applied.filesAfterRestrict === 0;
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
 * Build-artifacts spread: the raw `entries` list (for downstream
 * cross-referencing against findings, e.g. the vendor-CSS dominance
 * predicate), a `metaField` to mix into `meta` (omitted when no
 * artifacts), and a `present` boolean for
 * `warningsFieldFromScanMeta`.
 *
 * the meta field
 * carries the {@link BuildArtifactsGrouped} shape (grouped +
 * classified) rather than the flat `ScannedBuildArtifact[]` it used
 * to. Per CLAUDE.md §1 "Verbose meta is signal, not clutter," the
 * grouped form is a strict superset — every ≥3-entry basename
 * cluster collapses to one row with a paste-ready `suggestedGlob`,
 * and sub-threshold entries land in `classified[]` so zero
 * information is lost. The raw `entries` list and
 * `vendorLibraries` array stay in the worker-internal return shape:
 * the former for the vendor-CSS dominance predicate, the latter
 * for the animation-library guard cross-reference (Q12 lifted both
 * onto the wire `classified[]` surface but the per-call worker
 * still consumes them as separate inputs).
 */
function buildArtifactsFields(
  files: readonly ParsedFile[],
  root: string,
): {
  readonly present: boolean;
  readonly entries: readonly ScannedBuildArtifact[];
  readonly vendorLibraries: readonly DetectedVendorLibrary[];
  readonly metaField: { readonly scannedBuildArtifacts?: BuildArtifactsGrouped };
} {
  const entries = collectBuildArtifacts(files);
  // vendor-library detection runs
  // independently of build-artifact classification. The two predicates
  // are orthogonal — a file matching a banner is almost always also a
  // build artifact, but the banner answers "which library" while the
  // classifier answers "is this generated bytes." Q12 lifts both into
  // the unified `meta.scannedBuildArtifacts.classified[]` surface
  // with a `kind` discriminator, so a path firing both predicates
  // rides as one row carrying multiple `classifications[]` entries
  // — agents no longer have to union two parallel lists.
  const vendorLibraries = detectVendorLibraries(
    files.map((f) => ({ filePath: f.filePath, source: f.source })),
  );
  if (entries.length === 0 && vendorLibraries.length === 0) {
    return { present: false, entries, vendorLibraries, metaField: {} };
  }
  // Q12: pass `vendorLibraries` directly into the grouper so banner
  // identifications fold into `classified[]` alongside the per-file
  // build-artifact residue under a single sorted, capped tail.
  const scannedBuildArtifacts = groupBuildArtifactsByBasename(entries, root, vendorLibraries);
  return {
    // `present` reflects "any signal worth surfacing" — either
    // classified artifacts or an identified vendor library — so the
    // downstream `scanned_build_artifacts_present` warning code fires
    // for the vendor-library-only edge case too.
    present: true,
    entries,
    vendorLibraries,
    metaField: { scannedBuildArtifacts },
  };
}

/**.
 * Build a hash-set of the absolute
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
 * wrapper. Reads
 * `perRuleCoverage` off the scanner-assembled meta block, runs the
 * vendor-aware enricher, and returns either the same meta object
 * (identity-stable, when no row was rewritten — the common case on
 * scans without vendor build artifacts) or a shallow copy with the
 * `perRuleCoverage` field replaced. Extracted from the handler so
 * its cognitive-complexity score stays inside the lint budget; the
 * handler sees one named call instead of three intermediate bindings.
 *
 * The array cast is defensive — `formatted.meta` is typed as
 * `Record<string, unknown>` at this seam, but by construction the
 * builder always sets `perRuleCoverage` to a `PerRuleCoverage[]` when
 * the scan had any rules. Non-array values (should never happen in
 * practice) fall through to the empty-set branch and the helper is
 * an identity.
 */
function withVendorEnrichedPerRuleCoverage(
  meta: Readonly<Record<string, unknown>>,
  vendorPaths: ReadonlySet<string>,
): Readonly<Record<string, unknown>> {
  const raw = meta["perRuleCoverage"];
  const rows = Array.isArray(raw) ? (raw as readonly PerRuleCoverage[]) : [];
  const enriched = enrichPerRuleCoverageWithVendorConcentration(rows, vendorPaths);
  if (enriched === rows) return meta;
  return { ...meta, perRuleCoverage: enriched };
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
 * Default files-with-findings cap per scan_project response (+
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
 *
 * When pagination is active (any page after the first, or any page
 * where `truncated` fires), the response carries `requestedLimit` +
 * `effectiveLimit` + `pageClipReason` so a caller seeing "returned <
 * limit" can distinguish the three clip regimes without a re-page.
 * `end_of_results` is emitted at this layer only — the density cap
 * downstream overrides to `token_density` when it trims further.
 * Pages that returned exactly `limit` carry `effectiveLimit` equal to
 * `requestedLimit` and no `pageClipReason` (the "full page" is not
 * clipped at this layer).
 */
function paginateFiles<T>(
  files: readonly T[],
  { limit, offset }: PageParams,
): {
  readonly files: readonly T[];
  readonly paginationFields: {
    readonly truncated: boolean;
    readonly nextOffset?: number;
    readonly totalFilesWithFindings: number;
    readonly requestedLimit?: number;
    readonly effectiveLimit?: number;
    readonly pageClipReason?: "end_of_results";
  };
} {
  const page = files.slice(offset, offset + limit);
  const hasMore = offset + limit < files.length;
  // `truncated` and
  // `totalFilesWithFindings` ALWAYS ride on every scan_project response,
  // including the small-scan path where the whole result fit. The
  // negative answer ("not truncated, this is the full inventory") is
  // load-bearing: a caller reading `truncated: false` knows the
  // emitted file count IS the inventory size, while an absent field
  // forces the agent to disambiguate "not truncated" from "field
  // never emitted on this scan shape." Conditional-spread is wrong
  // here — present-when-meaningful applies only when absence carries
  // no signal; here, the negative IS the signal. See
  // `docs/kb/architecture/ai-first-consumer.md` "Ambiguous field
  // shapes are dishonest" + "Zero-output success is ambiguous failure"
  // for the rationale: a callable load-bearing predicate must always
  // resolve to true OR false, never "missing means false."
  if (!hasMore && offset === 0) {
    return {
      files: page,
      paginationFields: {
        truncated: false,
        totalFilesWithFindings: files.length,
      },
    };
  }
  const clippedByEnd = !hasMore && page.length < limit;
  return {
    files: page,
    paginationFields: {
      truncated: hasMore,
      ...(hasMore ? { nextOffset: offset + limit } : {}),
      totalFilesWithFindings: files.length,
      requestedLimit: limit,
      effectiveLimit: page.length,
      ...(clippedByEnd ? { pageClipReason: "end_of_results" as const } : {}),
    },
  };
}
