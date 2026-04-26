/**
 * The `coverage` MCP tool. Extracted from tools.ts so the audit
 * meta-tool can import it without creating a cycle — tools.ts also
 * pulls in auditTool, which in turn needs coverageTool. Logic is
 * unchanged from the original inline definition.
 */

import type { ParsedFile } from "../engine/scanner.ts";
import { runScan } from "../engine/scanner.ts";
import { buildCoverageReport } from "../reports/coverage.ts";
import { buildAnalysisCoverage } from "./analysis-coverage.ts";
import { collectBuildArtifacts } from "./build-artifacts.ts";
import { sawProjectMarkerInWalk } from "./config-search-marker.ts";
import { detectApplicability, splitManualCriteria } from "./manual-applicability.ts";
import { applyMetaCacheMode, metaModeSchema } from "./meta-cache.ts";
import { buildDerivativeScanWarnings } from "./response-assembler.ts";
import { buildRulesEvaluated, type RulesEvaluated, resolveActiveRules } from "./rules-evaluated.ts";
import { outputFilePathSet } from "./scan-assembly.ts";
import { type ScannedEnvelope, scannedProject } from "./scanned-envelope.ts";
import { configSearchedFromField } from "./scanner-meta.ts";
import type { McpSession } from "./session.ts";
import { deriveTestableCriteria } from "./testable-criteria.ts";
import {
  errorResult,
  firstUnknownStandard,
  loadDurableAttestations,
  type McpTool,
  parseFilesWithDiagnostics,
  resolveLevel,
  resolveStandards,
  strArrayParam,
  strParam,
  textResult,
} from "./tools-helpers.ts";
import { computeTemplateDirectiveOverlap, fillMissingWarningDetails } from "./warnings.ts";

export const coverageTool: McpTool = {
  def: {
    name: "coverage",
    description:
      "Check overall compliance coverage — passing/failing/manual counts per standard. Use after fixing violations to see if you're done. Call it without `paths` to cover the whole project (honors the same cwd + .gitignore + ra11y.config.ts as scan_project); pass `paths` only to narrow the question to a specific subtree.",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional. File or directory paths to scan. Omit for a project-wide coverage report rooted at `cwd`.",
        },
        standard: { type: "string", description: "Standard ID." },
        level: { type: "string", enum: ["A", "AA", "AAA"], description: "Conformance level." },
        cwd: {
          type: "string",
          description:
            "Base directory. Used as the scan root when `paths` is omitted, and for resolving relative `paths` when given.",
        },
        showUntargeted: {
          type: "boolean",
          description:
            "Include the full `untargetedCriteriaList` (bare WCAG titles for criteria no finder grounded in code). Default false; `untargetedCriteria` (the count) is always returned. Mirrors the `checklist` tool so both surfaces behave consistently.",
        },
        verboseMeta: {
          type: "boolean",
          description:
            "When true, the meta block expands its compact summaries into the underlying per-row payloads. Affects: `perRuleCoverage[]` (full per-rule coverage rows — at default verbosity replaced by `perRuleCoverageSummary: { ruleCount, ruleIds }`) and `analysisCoverage.parseErrorFiles` / `partialParseFiles` (full per-entry `{ path, parser, reason }` arrays uncapped — at default verbosity, counts ≤ 20 still ship inline; above 20 the response surfaces the `parseErrorTopReasons` / `partialParseTopReasons` rollup of top distinct reasons by frequency). The count scalar (`parseErrorFileCount` / `partialParseFileCount`) and the scan-confidence telemetry (`rulesEvaluated`, `rulesNotEvaluatedDueToInputType`) stay inline at every verbosity. Off by default to keep responses bounded on bulk-template scans; flip when triaging which specific files failed to parse or auditing per-rule confidence.",
        },
        metaMode: metaModeSchema,
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async handler(params, session) {
    const cwd = strParam(params, "cwd") ?? process.cwd();
    const paths = strArrayParam(params, "paths") ?? [cwd];

    const standards = resolveStandards(strParam(params, "standard"), session);
    const unknown = firstUnknownStandard(standards, session);
    if (unknown !== null) {
      const known = session.registry.standards.map((s) => s.id).join(", ");
      return errorResult({
        code: "standard-not-found",
        message: `Unknown standard '${unknown}'. Loaded: ${known}.`,
        details: { requested: unknown, loaded: session.registry.standards.map((s) => s.id) },
        remediation:
          "Pass `standard` with one of the loaded IDs, or omit to use the session default.",
      });
    }
    const level = resolveLevel(strParam(params, "level"), session);
    const projectConfig = await session.loadProjectConfig(cwd);
    const { files, diagnostics: discoveryDiagnostics } = await parseFilesWithDiagnostics(
      paths,
      session,
      cwd,
    );
    const attestations = await loadDurableAttestations(cwd);

    // Q-SHARED-RULES-EVALUATED-SSOT: load project config and route
    // through resolveActiveRules so the `meta.rulesEvaluated.loaded`
    // count agrees with scan_project / propose_config on the same cwd.
    // (`list_suppressions` no longer emits `rulesEvaluated` — the tool
    // runs zero rules, so the field would lie; see
    // V1-LIST-SUPPRESSIONS-RULES-EVALUATED-DRIFT.)
    const activeRules = resolveActiveRules(session, projectConfig);
    const { result, report, perRuleCoverage } = runScan({
      standards: session.registry.standards,
      rules: activeRules,
      enabled: standards,
      files,
      finders: session.registry.finders,
      level,
      ...(attestations.length > 0 && { attestations }),
    });

    const candidateCriteria = new Set((report.candidates ?? []).map((c) => c.criterionId));
    const applicability = detectApplicability(files, discoveryDiagnostics);
    // Q-SHARED-PASS-RATE-COMPOSITE: build the testable set from
    // perRuleCoverage so the coverage report can split automatable-pass
    // into `clean` (ran + zero findings) vs. `untestable` (satisfying
    // rules declared extension eligibility but saw zero applicable
    // input — canonical Tailwind-pre-build shape). Without this, a
    // minified vendor bundle whose only finding is a
    // review-candidate-only 2.2.1 setInterval silently sinks the
    // headline pass rate by inflating the denominator with rules that
    // never had anything to look at.
    const testableCriteria = deriveTestableCriteria(
      activeRules,
      perRuleCoverage,
      session.registry.criteria,
    );
    const coverage = buildCoverageReport(result, session.registry.standards, level, undefined, {
      testableCriteria,
    });
    const showUntargeted = params["showUntargeted"] === true;
    // V1-ZERO-SCAN-PASS-RATE-SENTINEL: on a zero-file scan, the pass-
    // rate denominator (`evaluated` or `automatable` depending on the
    // `testableCriteria` path) collapses to "no meaningful denominator"
    // — the `buildCoverageReport` helper returns `0` on one path and
    // `100` on the legacy path. Either number is dishonest: an agent
    // summing pass-rate dashboards counts the call as clean conformance
    // (or spurious failure) when the reality is "the scan never had
    // anything to evaluate." Omit `automatedCriteriaPassRate` entirely
    // in that case (present-when-meaningful per `ai-first-consumer.md`
    // §"Ambiguous field shapes are dishonest") — the
    // `scanned_zero_files` warning code already fires on this path and
    // communicates why. The per-criterion split counters stay populated
    // so the agent still sees the shape of the attempted evaluation.
    const passRateMeaningful = files.length > 0;
    const entries = coverage.map((c) => {
      // Split by applicability first so the counts align with scan_project
      // and checklist — media-only criteria move to likelyIrrelevant
      // when there's no <video>/<audio>, and never inflate the
      // review-required number.
      const { applicable, likelyIrrelevant } = splitManualCriteria(c.manualCriteria, applicability);
      const withCandidates = applicable.filter((id) => candidateCriteria.has(id));
      const untargeted = applicable.filter((id) => !candidateCriteria.has(id));
      return {
        standardId: c.standardId,
        // Named so the denominator is unmistakable: it's the share of
        // the `criteriaEvaluated` subset that passed (`clean /
        // evaluated`), not the share of the full standard. Previous
        // formula was `passing / automatable` — on a scan where a
        // minified vendor bundle supplies the only applicable input for
        // a given criterion, the old denominator inflated the
        // "automatable" count with untestable criteria (rules declared
        // eligible but had zero applicable input) and the pass rate
        // silently sank below reality (the canonical reveal-slide /
        // Tailwind-pre-build shape). Q-SHARED-PASS-RATE-COMPOSITE split
        // the denominator so the headline names one concept: "of the
        // criteria we actually evaluated, how many were clean?"
        ...(passRateMeaningful ? { automatedCriteriaPassRate: c.automatedPassRate } : {}),
        criteriaTotal: c.total,
        criteriaAutomatable: c.automatable,
        criteriaAutomatablePassing: c.passing,
        // Four-counter split for the automatable lane. Each counts one
        // kind of thing (per CLAUDE.md §1 "Composite headline counts are
        // dishonest"):
        //   - `criteriaEvaluated`: ran with eligible input (= clean +
        //     withFindings).
        //   - `criteriaClean`: ran, zero violations.
        //   - `criteriaWithFindings`: ran, ≥1 violation.
        //   - `criteriaUntestable`: rule declared extension eligibility
        //     but saw zero applicable input in this scan — the canonical
        //     Tailwind-pre-build / reveal-slide vendor-bundle shape. The
        //     list rides under `untestableCriteria` (with titles) so the
        //     agent can call out what it couldn't verify.
        // Invariant: `criteriaAutomatable === criteriaEvaluated +
        // criteriaUntestable` and `criteriaEvaluated === criteriaClean +
        // criteriaWithFindings`.
        criteriaEvaluated: c.evaluated,
        criteriaClean: c.clean,
        criteriaWithFindings: c.withFindings,
        criteriaUntestable: c.untestable,
        untestableCriteria: withTitles(c.untestableCriteria, session),
        criteriaManualReviewRequired: applicable.length,
        // Split the manual-review pile so agents can see at the coverage
        // level (without a second checklist call) how many manual
        // criteria have concrete candidates worth reviewing vs pure
        // WCAG prompts the finders couldn't ground in code.
        manualWithCandidates: withTitles(withCandidates, session),
        // Count is always informative ("how big is the untargeted tail");
        // the list is gated behind showUntargeted so the default response
        // doesn't ship 16 entries of bare WCAG titles that mirror the
        // checklist tool's showUntargeted default.
        //
        // Canonical count field is `untargetedCriteria`
        // (matches scan_project's `plan` and
        // checklist's `summary`). The list uses the distinct name
        // `untargetedCriteriaList` so the number and array fields don't
        // collide when both are present.
        untargetedCriteria: untargeted.length,
        ...(showUntargeted ? { untargetedCriteriaList: withTitles(untargeted, session) } : {}),
        likelyIrrelevantCriteria: withTitles(likelyIrrelevant, session),
        // Renamed from "automatedGaps" — agents consistently misread
        // that as "criteria automation can't cover" when it actually
        // listed automated criteria that are currently failing.
        failingAutomatedCriteria: withTitles(c.failingCriteria, session),
        // V1-ZERO-SCAN-PASS-RATE-SENTINEL: drop the `(N%)` tail when
        // the scan evaluated zero files — the `%` is cosmetically
        // precise but materially meaningless. Pair with the
        // `automatedCriteriaPassRate` omission above so the summary
        // and the structured field agree; the `scanned_zero_files`
        // warning code still fires at the response level.
        summary: passRateMeaningful
          ? `${c.clean}/${c.evaluated} evaluated automatable criteria passing (${c.automatedPassRate}%)` +
            `${c.untestable > 0 ? `; ${c.untestable} untestable (no applicable input in this scan)` : ""}. ` +
            `${applicable.length} of ${c.total} criteria in ${c.standardId} need manual review ` +
            `(${withCandidates.length} with concrete candidates, ${untargeted.length} untargeted` +
            `${likelyIrrelevant.length > 0 ? `; ${likelyIrrelevant.length} media-only criteria are irrelevant to this scan` : ""}). ` +
            `Run the 'checklist' tool for evaluation prompts.`
          : `No files scanned — automated pass rate is not meaningful. ` +
            `${applicable.length} of ${c.total} criteria in ${c.standardId} would need manual review once sources are present. ` +
            `See the \`scanned_zero_files\` warning for why the scan root matched no parseable files.`,
      };
    });

    // Scan-confidence telemetry mirroring `scan_project`'s
    // `meta.analysisCoverage` block. Per CLAUDE.md §1 "Verbose meta is
    // signal, not clutter," this is the same opaque-component /
    // template-directive / skipped-extension signal an agent uses to
    // decide whether the scan had teeth — if `coverage` said "20/20
    // automatable passing" while discovery silently rejected 114 .scss
    // files at the parseable-extension check, an agent gating "are we
    // done?" on the coverage response alone hits the canonical
    // silent-miss failure mode. The `coverage` handler doesn't compute
    // auto-detected wrappers, so that flag collapses to 0;
    // `verboseMeta` flows from the input param so an agent triaging
    // bulk-template parse errors can opt into the full
    // `parseErrorFiles` / `partialParseFiles` lists when needed
    // (V1-COVERAGE-PARSE-ERROR-FILES-UNCAPPED). Surfaced at the
    // top level (not gated by `metaMode`) because the signal is
    // load-bearing for a conformance-gating tool; the existing `meta`
    // block stays opt-in so legacy callers still see no meta on a
    // default call.
    const verboseMeta = params["verboseMeta"] === true;
    const analysisCoverageField = buildAnalysisCoverage(
      files,
      session.config.nativeWrappers,
      activeRules,
      verboseMeta,
      0,
      undefined,
      discoveryDiagnostics,
      // Parse-error split by same rule as the scan surfaces: files
      // that produced at least one violation OR review candidate land
      // in `partialParseFiles` (output present, recall degraded); files
      // whose parser errored without emitting anything stay in
      // `parseErrorFiles` (invisible to rules and finders alike). The
      // candidate union is load-bearing per V1-PARSE-ERROR-LIVERELOAD-
      // MIXED-SIGNAL — a source-text finder (e.g. `review/timing`
      // regex-scanning `ctx.source` even when the AST parse failed) can
      // surface grounded candidates from a file that produced zero
      // rule violations; without the union those files would mis-bucket
      // as `invisible-to-rules` while live candidates reach the caller.
      outputFilePathSet(result.violations, report.candidates ?? []),
    );
    // V1-CROSS-SURFACE-WARNINGS-CODE-SET-DRIFT: same scan state must
    // surface the same warning code set on every tool that runs the
    // scanner. Coverage previously omitted `no_config_found` (passed
    // `configSource: undefined`) and `scanned_build_artifacts_present`
    // (didn't run the detector); both codes ride on `scan_project` for
    // the same cwd. The agent reading warnings on `coverage` to gate
    // "are we done?" got a strict subset of the truth and would route
    // away from a real onboarding gap (no config) or a vendor-dump-
    // dominated scan (build artifacts) that `scan_project` had
    // already labelled. Thread `projectConfig.sourcePath` and run the
    // build-artifact detector here so the warning predicates fire
    // consistently. The `configSearchSawProjectMarker` probe gates
    // `no_config_found` per Q-SHARED-NO-CONFIG-WARNING-TINY-REPO so
    // tiny scratch-dir scans stay quiet on every surface.
    //
    // Doctrine (CLAUDE.md §1 "Zero-output success is ambiguous failure"):
    // a coverage response with `criteriaAutomatable: 0` etc. is
    // indistinguishable from "tool never ran" unless we surface the
    // honest scan-confidence codes — same input → same labels.
    const configSearchSawProjectMarker =
      projectConfig.sourcePath === null ? sawProjectMarkerInWalk(cwd) : false;
    const buildArtifactEntries = collectBuildArtifacts(files);
    const filesByExtension = countFilesByExtension(files);
    const baseWarnings = buildDerivativeScanWarnings({
      filesScanned: files.length,
      rootSource: null,
      configSource: projectConfig.sourcePath,
      analysisCoverage: analysisCoverageField.analysisCoverage,
      filesByExtension,
      scannedBuildArtifactsPresent: buildArtifactEntries.length > 0,
      configSearchSawProjectMarker,
      // Q-SHARED-META-ARRAY-BUDGET-CAP: propagate truncation so the
      // response-level `response_meta_truncated` code fires AND its
      // `warningsDetails.response_meta_truncated.fields` payload names
      // the structured fields elided. The coverage helper only caps
      // `analysisCoverage.fragmentFiles` (the build-artifact path
      // arrays don't surface through this seam — `tool-coverage` doesn't
      // assemble `scannedBuildArtifacts`), so the field list resolves
      // to a single dotted path when the cap fired.
      ...(analysisCoverageField.metaArrayTruncated === true
        ? { metaArrayTruncatedFields: ["analysisCoverage.fragmentFiles"] }
        : {}),
      // Q4-WARNING-DOWNGRADE-NOISE: gate
      // `template_files_parsed_as_literal` on actual overlap between
      // emitted findings and detected template-directive lines — the
      // code only fires when the literal-parse actually reached a
      // finding the agent must triage. `coverage` runs `runScan` over
      // the same parsed-file set it discovered; cross-reference
      // `result.violations` with the per-file source already in
      // `files`.
      templateDirectivesOverlap: computeTemplateDirectiveOverlap({
        findings: result.violations.map((v) => ({
          filePath: v.location.filePath,
          line: v.location.line,
        })),
        sourcesByPath: new Map(files.map((f) => [f.filePath, f.source])),
      }),
    });
    // Q7-CRITERION-ID-FIELD-NAME-DRIFT: every coverage entry ships the
    // legacy `id` field alongside the canonical `criterionId` for one
    // minor as a deprecation alias (see `withTitles`). Fire the
    // structured warning unconditionally on this path so agents reading
    // the warnings channel know the alias is going away — the entry
    // arrays are always emitted, so the alias is always present. Removed
    // alongside the alias in the next minor release; the
    // `### Deprecated` CHANGELOG entry tracks the removal window.
    const warnings = mergeDeprecatedFieldIdWarning(baseWarnings);
    // V1-COVERAGE-META-BLOCK-MISSING: every tool that runs the scanner
    // ships a `meta` block carrying load-bearing scan-confidence
    // telemetry — `filesScanned`, `configSource`, `rootSource`,
    // `rulesEvaluated`, `scanned`, plus the conditional
    // `configSearchedFrom`. Coverage previously gated this entire
    // block behind `metaMode: "delta"`, so the default "full" call
    // shipped no meta at all. An agent that ran `scan_project({ cwd })`
    // followed by `coverage({ cwd })` to gate "are we done?" couldn't
    // verify the two calls scanned the same input set — silent
    // cross-surface drift per `docs/kb/architecture/ai-first-consumer.md`
    // "Cross-surface count invariant." Mirror scan_project's meta shape
    // here; the meta-cache `metaMode` knob still applies (delta-mode
    // collapses repeat calls to a sessionRef-keyed delta) but no
    // longer suppresses the block on the default path.
    const scannedEnvelope = scannedProject(cwd);
    const metaField = buildCoverageMetaField({
      params,
      session,
      filesScanned: files.length,
      configSource: projectConfig.sourcePath,
      scannedEnvelope,
      rulesEvaluated: buildRulesEvaluated({
        loadedCount: activeRules.length,
        perRuleCoverage,
      }),
      enabledStandards: standards,
      level,
      cwd,
    });
    // Historical shape: single object when one standard is enabled,
    // array-of-entries when multiple. Warnings ride at the top level of
    // the response per doctrine. For the single-standard path (by far
    // the common case) we spread warnings alongside the entry fields;
    // the multi-standard path keeps its array shape unchanged, so a
    // future consumer expecting `Array.isArray(response)` doesn't
    // regress. Warnings on a zero-file multi-standard scan would also
    // need the per-response envelope, but adding it conditionally here
    // would split the wire shape on a signal invisible to the schema —
    // we leave that path unchanged until a concrete consumer needs it.
    if (entries.length === 1) {
      const entry = entries[0];
      // ADR 0010 cross-pointing. `coverage` answers "how close are we
      // to conformance?" — its `nextStep` routes the caller onward
      // to the matching workflow surface:
      //   - manualWithCandidates non-empty → `checklist` (grounded
      //     candidates with file:line are the honest next question);
      //   - manualWithCandidates empty but failingAutomated present →
      //     `scan_project` (fix violations before reviewing manual);
      //   - both empty → omit (clean report, no follow-up to name).
      // Conditional-spread discipline (CLAUDE.md §1): `nextStep` +
      // `nextStepStructured` ship as one unit or not at all.
      const nextStep = entry
        ? buildCoverageNextStep({
            manualWithCandidatesLen: entry.manualWithCandidates.length,
            failingAutomatedLen: entry.failingAutomatedCriteria.length,
            cwd,
            standard: strParam(params, "standard"),
            level: strParam(params, "level"),
          })
        : {};
      return textResult({
        ...entry,
        ...nextStep,
        // V1-COVERAGE-SCANNED-POINTER-MISSING: `coverage` runs a real
        // scan over the resolved cwd (see `runScan` above) — surface
        // the same `scanned` envelope `scan_project` emits so an agent
        // calling `coverage({ cwd })` to confirm "are we done?" can
        // verify *what* was scanned without a separate `scan_project`
        // round trip. Cross-surface drift between the two pointers is
        // dishonest per ai-first-consumer.md ("One tool call should
        // answer 'what next?'"). Top-level (not gated by `metaMode`)
        // because it's load-bearing scan-confidence telemetry, mirror
        // of how `analysisCoverage` already escapes the meta block on
        // this tool.
        scanned: scannedProject(cwd),
        ...analysisCoverageField,
        ...metaField,
        ...warnings,
      });
    }
    return textResult(entries);
  },
};

/**
 * Assembles the `meta` field for `coverage`. V1-COVERAGE-META-BLOCK-
 * MISSING + V1-CROSS-SURFACE-WARNINGS-CODE-SET-DRIFT: every tool that
 * runs the scanner ships the same load-bearing scan-confidence
 * telemetry (filesScanned, configSource, rootSource, rulesEvaluated,
 * scanned, configSearchedFrom) so an agent that calls `scan_project`
 * followed by `coverage` on the same cwd can verify both walked the
 * same file set. The block ships unconditionally on the default
 * `metaMode: "full"` path; `metaMode: "delta"` still collapses repeat
 * calls through {@link applyMetaCacheMode} for tight tool-call loops.
 *
 * `rootSource: "explicit"` because `coverage` resolves its scan root
 * from the caller's `cwd` param (defaulting to `process.cwd()`) — the
 * same precedence `scan_project` uses for an explicit cwd. No
 * host-root / git-root / spawn-cwd fallback chain on this tool.
 *
 * Scoped to the single-standard return shape (where the response
 * envelope is an object); the multi-standard array shape stays
 * unchanged until a concrete consumer needs opt-in there.
 */
function buildCoverageMetaField(args: {
  readonly params: Record<string, unknown>;
  readonly session: McpSession;
  readonly filesScanned: number;
  readonly configSource: string | null;
  readonly scannedEnvelope: ScannedEnvelope;
  readonly rulesEvaluated: RulesEvaluated;
  readonly enabledStandards: readonly string[];
  readonly level: "A" | "AA" | "AAA";
  readonly cwd: string;
}): { readonly meta: Record<string, unknown> } {
  const callerCwd =
    typeof args.params["cwd"] === "string" ? (args.params["cwd"] as string) : undefined;
  const fullMeta: Record<string, unknown> = {
    cwd: args.cwd,
    filesScanned: args.filesScanned,
    scanned: args.scannedEnvelope,
    configSource: args.configSource,
    // Q8-CONFIGSEARCHEDFROM-ECHO-RECURRENCE: the shared helper omits
    // when the search base would echo `cwd` or `scanned.root` already
    // on the response. `coverage` walks up from `args.cwd`, so the
    // base equals `scanned.root` on every default-shape call and the
    // field is consistently dropped — uniform with `scan_project`.
    ...configSearchedFromField({
      searchBase: args.cwd,
      callerCwd,
      scanned: args.scannedEnvelope,
    }),
    rootSource: "explicit" as const,
    rulesEvaluated: args.rulesEvaluated,
    standards: [...args.enabledStandards],
    level: args.level,
  };
  return {
    meta: applyMetaCacheMode({
      toolName: "coverage",
      params: args.params,
      fullMeta,
      session: args.session,
    }),
  };
}

interface CoverageNextStepInputs {
  readonly manualWithCandidatesLen: number;
  readonly failingAutomatedLen: number;
  readonly cwd: string;
  readonly standard: string | undefined;
  readonly level: string | undefined;
}

/**
 * Builds the `coverage` tool's cross-pointing next-step pair per
 * ADR 0010.
 *
 * Three branches:
 *   - manualWithCandidates non-empty → point at `checklist` (grounded
 *     review candidates are the honest next question).
 *   - empty but failingAutomated non-empty → point at `scan_project`
 *     (the agent should fix automated violations before working the
 *     manual queue).
 *   - otherwise (clean report) → omit both fields (honest-shape per
 *     CLAUDE.md §1 — no follow-up to name).
 */
function buildCoverageNextStep({
  manualWithCandidatesLen,
  failingAutomatedLen,
  cwd,
  standard,
  level,
}: CoverageNextStepInputs): {
  readonly nextStep?: string;
  readonly nextStepStructured?: { readonly tool: string; readonly args: Record<string, unknown> };
} {
  if (manualWithCandidatesLen > 0) {
    const args: Record<string, unknown> = { cwd };
    if (standard !== undefined) args["standard"] = standard;
    if (level !== undefined) args["level"] = level;
    return {
      nextStep:
        "Call `checklist` to work through manual-review candidates with concrete file:line locations.",
      nextStepStructured: { tool: "checklist", args },
    };
  }
  if (failingAutomatedLen > 0) {
    return {
      nextStep:
        "Automated criteria are failing. Call `scan_project` to see the violations with file:line and fix suggestions.",
      nextStepStructured: { tool: "scan_project", args: { cwd } },
    };
  }
  return {};
}

/**
 * Enriches bare criterion IDs (e.g. "wcag22:2.4.11") with their titles
 * ("Focus Not Obscured (Minimum)") so agents don't have to look them up.
 * Falls back to ID-only if a criterion isn't found in any loaded standard.
 *
 * Q7-CRITERION-ID-FIELD-NAME-DRIFT: the canonical field is
 * `criterionId` — matches `checklist.items[].criterionId` and the
 * namespaced-id convention used elsewhere across the MCP surface
 * (`wcag22:1.4.3`). The legacy `id` field still ships alongside
 * `criterionId` for one minor release as a deprecated alias so callers
 * that learned the old name keep working; the alias is removed in the
 * next minor release. The `deprecated_field_id_renamed_criterionId`
 * warning code (see `src/mcp/warnings.ts`) fires whenever any coverage
 * response emits the alias so agents can drop their `id` reads on the
 * next call.
 */
function withTitles(
  criterionIds: readonly string[],
  session: import("./session.ts").McpSession,
): readonly {
  readonly criterionId: string;
  readonly id: string;
  readonly title: string;
  readonly level: string;
}[] {
  return criterionIds.map((id) => {
    for (const std of session.registry.standards) {
      const c = std.criteria.find((cr) => cr.id === id);
      if (c) return { criterionId: id, id, title: c.title, level: c.level };
    }
    return { criterionId: id, id, title: "", level: "" };
  });
}

/**
 * Q7-CRITERION-ID-FIELD-NAME-DRIFT: append the deprecation code for the
 * legacy `id` alias to the warnings fragment returned by
 * {@link buildDerivativeScanWarnings}. The base helper conditionally
 * spreads `warnings` and `warningsDetails` — `warnings` may be absent
 * when no scan-level code fired. We fold our code in either way:
 *   - if `warnings` is already present, append.
 *   - if absent, create a fresh single-element array.
 *
 * Warnings-details schema discipline: the deprecation code is a
 * binary-presence shape, so we stamp the empty-object marker on
 * `warningsDetails` (via {@link fillMissingWarningDetails}) so every
 * fired code has a key. When `base.warningsDetails` is absent the
 * helper builds a fresh map from the code list; when present, the
 * helper stamps the missing marker only.
 */
function mergeDeprecatedFieldIdWarning(base: {
  readonly warnings?: readonly import("./warnings.ts").ScanWarningCode[];
  readonly warningsDetails?: import("./warnings.ts").ScanWarningDetails;
}): {
  readonly warnings: readonly import("./warnings.ts").ScanWarningCode[];
  readonly warningsDetails: import("./warnings.ts").ScanWarningDetails;
} {
  const code: import("./warnings.ts").ScanWarningCode = "deprecated_field_id_renamed_criterionId";
  const next = base.warnings === undefined ? [code] : [...base.warnings, code];
  return {
    warnings: next,
    warningsDetails: fillMissingWarningDetails(next, base.warningsDetails),
  };
}

/**
 * Tallies parseable files by extension. Mirrors the private helper in
 * {@link ./scan-assembly.ts `countByExtension`} — duplicated rather than
 * re-exported so tool-coverage stays independent of scan-assembly's
 * other coupling. The map feeds `warningsField` so the Tailwind-
 * undercount condition can evaluate against the same signal `scan_project`
 * uses; also allows a future `coverage` caller to diff `filesByExtension`
 * across runs without re-parsing.
 */
function countFilesByExtension(files: readonly ParsedFile[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const f of files) {
    const dot = f.filePath.lastIndexOf(".");
    const ext = dot === -1 ? "(no-ext)" : f.filePath.slice(dot);
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}
