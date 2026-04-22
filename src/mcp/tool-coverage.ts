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
import { detectApplicability, splitManualCriteria } from "./manual-applicability.ts";
import { applyMetaCacheMode, metaModeSchema, readMetaMode } from "./meta-cache.ts";
import { buildDerivativeScanWarnings } from "./response-assembler.ts";
import { buildRulesEvaluated, type RulesEvaluated, resolveActiveRules } from "./rules-evaluated.ts";
import type { McpSession } from "./session.ts";
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
import { computeTemplateDirectiveOverlap } from "./warnings.ts";

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
    // count agrees with scan_project / propose_config / list_suppressions
    // on the same cwd.
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
    const applicability = detectApplicability(files);
    const coverage = buildCoverageReport(result, session.registry.standards, level);
    const showUntargeted = params["showUntargeted"] === true;
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
        // the `criteriaAutomatable` subset that passed, not the share of
        // the full standard. Previous name ("automatedPassRate") was
        // repeatedly misread as overall conformance.
        automatedCriteriaPassRate: c.automatedPassRate,
        criteriaTotal: c.total,
        criteriaAutomatable: c.automatable,
        criteriaAutomatablePassing: c.passing,
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
        summary:
          `${c.passing}/${c.automatable} automatable criteria passing (${c.automatedPassRate}%). ` +
          `${applicable.length} of ${c.total} criteria in ${c.standardId} need manual review ` +
          `(${withCandidates.length} with concrete candidates, ${untargeted.length} untargeted` +
          `${likelyIrrelevant.length > 0 ? `; ${likelyIrrelevant.length} media-only criteria are irrelevant to this scan` : ""}). ` +
          `Run the 'checklist' tool for evaluation prompts.`,
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
    // auto-detected wrappers or a verbose-meta toggle, so the feature
    // flags collapse to defaults: session wrappers for opaque-component
    // filtering, non-verbose, 0 auto-detect-confirmed. Surfaced at the
    // top level (not gated by `metaMode`) because the signal is
    // load-bearing for a conformance-gating tool; the existing `meta`
    // block stays opt-in so legacy callers still see no meta on a
    // default call.
    const analysisCoverageField = buildAnalysisCoverage(
      files,
      session.config.nativeWrappers,
      activeRules,
      false,
      0,
      undefined,
      discoveryDiagnostics,
      // Parse-error split by same rule as the scan surfaces: files
      // that produced at least one violation land in
      // `partialParseFiles` (findings present, recall degraded);
      // files whose parser errored without emitting anything stay
      // in `parseErrorFiles` (invisible to rules).
      new Set(result.violations.map((v) => v.location.filePath)),
    );
    // Doctrine (CLAUDE.md §1 "Zero-output success is ambiguous failure"):
    // a coverage response with `criteriaAutomatable: 0` etc. is
    // indistinguishable from "tool never ran" unless we surface the
    // honest "scanned_zero_files" / "extensions_skipped_no_parser"
    // codes. `coverage` has no root-resolution step (takes `paths`
    // directly, defaulting to `[cwd]`) and doesn't load project config
    // in this handler; mirror the `scan` tool's inputs for the other
    // codes. The `analysisCoverage` block we just built is passed in so
    // `extensions_skipped_no_parser` fires whenever discovery rejected
    // files on the parseable-extension check — same condition as
    // scan_project.
    const filesByExtension = countFilesByExtension(files);
    const warnings = buildDerivativeScanWarnings({
      filesScanned: files.length,
      rootSource: null,
      configSource: undefined,
      analysisCoverage: analysisCoverageField.analysisCoverage,
      filesByExtension,
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
    // `meta` is opt-in per `metaMode` — legacy callers (no metaMode)
    // never saw a `meta` block on this tool, and additive surface
    // creep is avoided by emitting under `metaMode: "delta"` only so
    // the session meta-cache has something to collapse on repeat
    // calls. The telemetry we DO ship (filesScanned, rulesEvaluated,
    // standards, level, cwd) is scan-confidence data an agent uses to
    // cross-check parity with the scan-family tools (CLAUDE.md §1
    // "Verbose meta is signal, not clutter").
    const metaField = buildCoverageMetaField({
      params,
      session,
      filesScanned: files.length,
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
        ...analysisCoverageField,
        ...metaField,
        ...warnings,
      });
    }
    return textResult(entries);
  },
};

/**
 * Assembles the optional `meta` field for `coverage`. Emitted only
 * when `metaMode: "delta"` is requested so legacy callers see no shape
 * change (the tool had no `meta` block historically). Under delta mode
 * we collect scan-confidence telemetry (filesScanned, rulesEvaluated,
 * enabled standards, level, cwd) and hand it to the shared meta-cache
 * helper — repeat calls with the same signature collapse to a delta
 * keyed by `sessionRef`. Scoped to the single-standard return shape
 * (where the response envelope is an object); the multi-standard array
 * shape stays unchanged until a concrete consumer needs opt-in there.
 */
function buildCoverageMetaField(args: {
  readonly params: Record<string, unknown>;
  readonly session: McpSession;
  readonly filesScanned: number;
  readonly rulesEvaluated: RulesEvaluated;
  readonly enabledStandards: readonly string[];
  readonly level: "A" | "AA" | "AAA";
  readonly cwd: string;
}): { readonly meta?: Record<string, unknown> } {
  if (readMetaMode(args.params) === "full") return {};
  const fullMeta: Record<string, unknown> = {
    cwd: args.cwd,
    filesScanned: args.filesScanned,
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
 */
function withTitles(
  criterionIds: readonly string[],
  session: import("./session.ts").McpSession,
): readonly { readonly id: string; readonly title: string; readonly level: string }[] {
  return criterionIds.map((id) => {
    for (const std of session.registry.standards) {
      const c = std.criteria.find((cr) => cr.id === id);
      if (c) return { id, title: c.title, level: c.level };
    }
    return { id, title: "", level: "" };
  });
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
