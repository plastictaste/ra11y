/**
 * The `coverage` MCP tool. Extracted from tools.ts so the audit
 * meta-tool can import it without creating a cycle — tools.ts also
 * pulls in auditTool, which in turn needs coverageTool. Logic is
 * unchanged from the original inline definition.
 */

import type { Registry } from "../engine/registry/registry.ts";
import type { ParsedFile } from "../engine/scanner.ts";
import { buildCoverageReport } from "../reports/coverage.ts";
import type { ReviewCandidate } from "../types/review.ts";
import type { Rule } from "../types/rule.ts";
import type { Violation } from "../types/violation.ts";
import { buildAnalysisCoverage } from "./analysis-coverage.ts";
import { sawProjectMarkerInWalk } from "./config-search-marker.ts";
import { applyCoverageBudget } from "./coverage-budget.ts";
import { runScanForCrossSurfaceParity } from "./cross-surface-scan.ts";
import { probeExtensionsPresentAtRoot } from "./extension-subkind.ts";
import { detectApplicability, splitManualCriteria } from "./manual-applicability.ts";
import { applyMetaCacheMode, metaModeSchema } from "./meta-cache.ts";
import { requireBooleanParam, requireStringArrayParam } from "./param-validators.ts";
import {
  buildSharedPerRuleCoverageMeta,
  type SharedPerRuleCoverageMetaResult,
} from "./per-rule-coverage-shared.ts";
import { buildRulesEvaluated, type RulesEvaluated, resolveActiveRules } from "./rules-evaluated.ts";
import { buildScanTimeWarnings } from "./scan-time-warnings.ts";
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
  type StructuredError,
  strArrayParam,
  strParam,
  textResult,
} from "./tools-helpers.ts";

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
            "When true, the meta block expands its compact summaries into the underlying per-row payloads. Affects: `perRuleCoverage[]` (full per-rule coverage rows — at default verbosity replaced by `perRuleCoverageSummary: { ruleCount, ruleIds }`) and `analysisCoverage.parseErrorFiles` / `partialParseFiles` (full per-entry `{ path, parserAttempted, naturalParser?, reason }` arrays uncapped — at default verbosity, counts ≤ 20 still ship inline; above 20 the response surfaces the `parseErrorTopReasons` / `partialParseTopReasons` rollup of top distinct reasons by frequency). `parserAttempted` is the parser the dispatcher actually invoked (routing decision); `naturalParser` is present-when-meaningful, only surfaced when the dispatcher routed the file through a non-natural parser (`.js` → tsx, `.svg` → html). The count scalar (`parseErrorFileCount` / `partialParseFileCount`) and the scan-confidence telemetry (`rulesEvaluated`, `filesWithAnyRuleEvaluated` / `filesWithZeroRuleEvaluation`, `rulesNotEvaluatedDueToInputType`) stay inline at every verbosity. Off by default to keep responses bounded on bulk-template scans; flip when triaging which specific files failed to parse or auditing per-rule confidence.",
        },
        metaMode: metaModeSchema,
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async handler(params, session) {
    // Type-check `paths` / `showUntargeted` / `verboseMeta` up front so
    // wrong-type inputs surface as `invalid-param` rather than silently
    // falling back to defaults. Mirrors `configure-opts.ts.allowWrite`'s
    // closure of the same silent-drop class.
    const paramTypeError = validateCoverageParamTypes(params);
    if (paramTypeError !== undefined) return errorResult(paramTypeError);
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
    const {
      files,
      diagnostics: discoveryDiagnostics,
      jsInnerHtmlDeclinedCount,
      jsInnerHtmlPatternSamples,
    } = await parseFilesWithDiagnostics(paths, session, cwd);
    const attestations = await loadDurableAttestations(cwd);

    // Q-SHARED-RULES-EVALUATED-SSOT: load project config and route
    // through resolveActiveRules so the `meta.rulesEvaluated.loaded`
    // count agrees with scan_project / propose_config on the same cwd.
    // (`list_suppressions` no longer emits `rulesEvaluated` — the tool
    // runs zero rules, so the field would lie; see
    //.)
    const activeRules = resolveActiveRules(session, projectConfig);
    // route the scan through the
    // shared cross-surface helper so `nativeWrapperElements` and
    // `processes` are threaded onto {@link runScan} with the same
    // presence rules `scan_project` uses. Without this, a real-corpus
    // scan with `nativeWrappers` configured (or `processes` declared)
    // produced different `result.violations` than `scan_project`'s on
    // the same cwd, and the `outputFilePathSet` derivation silently
    // drifted — feeding mismatched `findingFilePaths` into the
    // `parseErrorFiles` vs `partialParseFiles` bucket assembler. Per
    // `docs/kb/architecture/ai-first-consumer.md` "Cross-surface count
    // invariant" the per-bucket axis must agree on identical input,
    // not just the totals.
    const { result, report, perRuleCoverage, filesWithAnyRuleEvaluated, outputFilePaths } =
      runScanForCrossSurfaceParity({
        files,
        session,
        enabled: standards,
        level,
        activeRules,
        attestations,
        projectConfig,
        scanRoot: cwd,
      });

    const candidateCriteria = new Set((report.candidates ?? []).map((c) => c.criterionId));
    // Per-criterion candidate counts the per-entry
    // `manualCandidatesTotal` reads off. Single pass over the candidate
    // stream populates every entry the per-standard split below needs;
    // the standard-level filter happens at read time when we sum over
    // `withCandidates` (level-filtered, in-scope criteria for the
    // entry). See {@link buildCandidateCountByCriterion} for doctrine.
    const candidateCountByCriterion = buildCandidateCountByCriterion(report.candidates ?? []);
    const criteriaWithErrorViolations = collectErrorSeverityCriteria(result.violations);
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
    // on a zero-file scan, the pass-
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
    // Q9-COVERAGE-CRITERIA-AUTOMATABLE-DRIFTS-NARROW-VS-BULK:
    // `criteriaAutomatable` is a property of the standard module + the
    // loaded ruleset, not of the per-scan corpus. The legacy formula
    // (count metadata-non-manual criteria PLUS metadata-manual criteria
    // that fired in this scan) was corpus-derived: a metadata-manual
    // criterion satisfied by a registered rule that didn't happen to
    // fire on a narrow `paths:` slice would count as `manual` there but
    // promoted to `automatable` once a bulk scan fired the same rule —
    // 32 vs 34 on identical standard/level. Per `ai-first-consumer.md`
    // "Cross-surface count invariant," counts that name the same
    // concept must agree on the same input. Compute the registry-derived
    // count once per response and emit it for `criteriaAutomatable`; the
    // per-scan `c.automatable` still drives the `clean` / `withFindings`
    // / `untestable` lanes (which are corpus-derived by definition).
    const automatableByRegistry = countAutomatableCriteriaByRegistry(
      session.registry,
      activeRules,
      level,
    );
    const entries = coverage.map((c) => {
      const { applicable, likelyIrrelevant } = splitManualCriteria(c.manualCriteria, applicability);
      // Q13-SCAN-FILE-PLAN-VS-REVIEW-CANDIDATES-DISAGREE:
      // `withCandidates` lists every distinct criterion in THIS
      // standard (not just the metadata-manual subset) that has at
      // least one shipped grounded review candidate. Pre-Q13 the
      // filter narrowed to `applicable.filter(...)` — `applicable`
      // is metadata-manual minus likely-irrelevant, so a candidate
      // for `wcag22:2.4.3` (focus-order, `automatable: "partial"`)
      // shipped by the scanner never made the list, while
      // `summary.actionable.criteria` did count it once
      // `tallyManualCriteriaFromCoverage` switched to
      // distinct-criteria-with-candidates semantics. The
      // cross-surface count invariant
      // (`scan.plan.actionableManualItems ===
      // coverage.entries[0].manualWithCandidates.length`) requires
      // this surface use the same definition. `untargeted` keeps
      // the narrow metadata-manual-without-candidate scope — see
      // the `tallyManualCriteriaFromCoverage` doctrine note for why
      // the bare-prompt surface only makes sense for metadata-manual
      // criteria.
      //
      // The walk is over `c.criteria` (level-filtered, in-scope for
      // this standard) so AAA criteria with shipped candidates don't
      // appear when the caller scopes to `level: "AA"` — matches the
      // helper's level-filter scope and the checklist `items[]`
      // build that iterates `manualCriteria` (also level-filtered).
      const withCandidates = c.criteria
        .map((cc) => cc.criterionId)
        .filter((id) => candidateCriteria.has(id));
      // Candidate-level total scoped to the same in-scope, level-
      // filtered criteria `withCandidates` is computed from.
      // `withCandidates.length` / `actionableManualItems` is the
      // criteria-axis sibling; `manualCandidatesTotal` is the
      // candidate-axis sibling — names make the kind explicit so an
      // agent reading both does not silently reconcile two numbers
      // that measure different units (per
      // `docs/kb/architecture/ai-first-consumer.md` "Sibling fields
      // naming the same concept must use one shape"). Cross-surface
      // invariant: agrees with `checklist.totalCandidates` and
      // `checklist.summary.actionable.candidatesUncapped` on identical
      // cwd.
      const manualCandidatesTotal = sumCandidatesAcrossCriteria(
        withCandidates,
        candidateCountByCriterion,
      );
      const untargeted = applicable.filter((id) => !candidateCriteria.has(id));
      const { failingErrorIds, warningOnlyIds } = splitFailingByErrorPresence(
        c.failingCriteria,
        criteriaWithErrorViolations,
      );
      const registryAutomatable = automatableByRegistry.get(c.standardId) ?? c.automatable;
      // Pre-compute the present-when-meaningful spread payloads as
      // single-key objects so the entry literal stays free of inline
      // ternaries (each ternary inside the literal would bump the
      // map closure's cognitive-complexity score). Empty arrays drop
      // entirely via `buildOptionalArrayField` so the wire shape
      // signals "absent on this corpus" via field omission rather
      // than an empty-array sentinel.
      const untestableField = buildOptionalArrayField(
        "untestableCriteria",
        withTitles(c.untestableCriteria, session),
      );
      const manualWithCandidatesField = buildOptionalArrayField(
        "manualWithCandidates",
        withTitles(withCandidates, session),
      );
      const untargetedListField = buildUntargetedListField(
        showUntargeted,
        withTitles(untargeted, session),
      );
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
        // Renamed from `criteriaTotal` — the bare counter was unanchored
        // from the active conformance-level qualifier, so an agent
        // running `coverage({ level: "AA" })` couldn't tell from the
        // response alone whether `total` reflected the AA-scoped shape
        // or the full `AAA` row count. The new name makes the profile
        // explicit; the sibling `criteriaByLevel` carries the per-level
        // breakdown so the total is verifiable against its parts. Per
        // `docs/kb/architecture/ai-first-consumer.md` "Ambiguous field
        // shapes are dishonest." Pre-1.0 in-place rename — no alias
        // dual-emission window (same precedent as the `id` →
        // `criterionId` rename on these entries; ADR 0028 records the
        // doctrine for pre-release shape changes).
        criteriaTotalForProfile: c.total,
        // Per-level breakdown — values sum to `criteriaTotalForProfile`
        // exactly. WCAG-shaped standards surface `A` / `AA` / `AAA`
        // keys (filtered down to the requested `level`); level-less
        // standards (Section 508, EN 301 549) surface a single `base`
        // key. Keys are present only for levels the filtered standard
        // actually populates — present-when-meaningful (no
        // `{ A: 0, AA: 0, AAA: 0 }` sentinel maps).
        criteriaByLevel: c.criteriaByLevel,
        // Standard-fixed: count of criteria a registered rule satisfies
        // (after the active-rules config filter), level-narrowed to the
        // requested profile. Independent of the scanned corpus — narrow
        // and bulk scans on the same standard/level produce the same
        // value. Closes Q9-COVERAGE-CRITERIA-AUTOMATABLE-DRIFTS-NARROW-VS-BULK.
        criteriaAutomatable: registryAutomatable,
        criteriaAutomatablePassing: c.passing,
        // Three-counter split for the corpus-derived evaluation of the
        // criteria the rule library can statically address. Each counts
        // one kind of thing (per CLAUDE.md §1 "Composite headline counts
        // are dishonest"):
        //   - `criteriaEvaluated`: ran with eligible input (= clean +
        //     withFindings).
        //   - `criteriaClean`: ran, zero violations.
        //   - `criteriaWithFindings`: ran, ≥1 violation.
        // The "rule declared extension eligibility but saw zero
        // applicable input" lane (canonical Tailwind-pre-build /
        // reveal-slide vendor-bundle shape) is named once on this
        // response by the `untestableCriteria` array — agents derive
        // the count via `untestableCriteria.length` (or read it off
        // `summary.automatedCoverage.criteriaWithoutEligibleInputs`
        // already on this entry). The previous `criteriaUntestable`
        // scalar sibling was deleted because it duplicated the array
        // length verbatim — the canonical "Sibling fields naming the
        // same concept must use one shape" failure mode in
        // `docs/kb/architecture/ai-first-consumer.md`.
        // Invariant on the corpus-derived lane:
        // `criteriaEvaluated === criteriaClean + criteriaWithFindings`.
        // `criteriaAutomatable` is registry-derived (see comment above)
        // and is not necessarily equal to `criteriaEvaluated +
        // untestableCriteria.length` — a metadata-manual criterion
        // satisfied by a registered rule that didn't fire counts in
        // `criteriaAutomatable` but stays in the manual lane
        // (`manualCriteria`).
        criteriaEvaluated: c.evaluated,
        criteriaClean: c.clean,
        criteriaWithFindings: c.withFindings,
        // Present-when-meaningful: when the rule library satisfied
        // every applicable input lane on this corpus, an empty array
        // would be the dishonest sentinel-empty-list shape per
        // `docs/kb/architecture/ai-first-consumer.md` "Sibling fields
        // naming the same concept must use one shape" (omit empty
        // arrays when meaning is "absent on this corpus"). Agents
        // enumerate the criteria the static scan couldn't verify by
        // reading `untestableCriteria`; an absent field is the honest
        // answer for "nothing in this lane on this corpus" — the
        // structured
        // `summary.automatedCoverage.criteriaWithoutEligibleInputs`
        // count still rides on this same entry for the per-axis tally.
        ...untestableField,
        // Candidate-axis sibling to `manualWithCandidates.length` (the
        // criteria-axis count). `manualWithCandidates.length: N` reads
        // as "N criteria have grounded candidates";
        // `manualCandidatesTotal: K` reads as "K total candidates ride
        // under those criteria." The two sit alongside so an agent
        // asking "how many manual-review items are there" sees both
        // axes in one read instead of having to pivot to `checklist`
        // to learn the candidate-level tally. Cross-surface count
        // invariant (`docs/kb/architecture/ai-first-consumer.md`):
        // equals `checklist.totalCandidates` and
        // `checklist.summary.actionable.candidatesUncapped` on
        // identical cwd; pinned by the integration test in
        // `tests/integration/mcp-counts-agree.test.ts`.
        manualCandidatesTotal,
        // Manual-review pile in array form. Agents derive the
        // criteria-axis count via `manualWithCandidates.length`; the
        // structured `summary.actionable.criteria` ships the same
        // value alongside for the parallel `summary` access path that
        // mirrors `checklist.summary.actionable.criteria`. The
        // previous `actionableManualItems` scalar sibling was deleted
        // — duplicate of the array length, the "Sibling fields naming
        // the same concept must use one shape" failure mode in
        // `docs/kb/architecture/ai-first-consumer.md`. Present-when-
        // meaningful: omit when empty so the response distinguishes
        // "no grounded candidates this corpus" (field absent) from
        // "scanner ran and grounded these criteria" (populated array).
        // Cross-surface count invariant:
        // `manualWithCandidates.length` equals
        // `scan_project.plan.actionableManualItems` and
        // `checklist.summary.actionable.criteria` on identical cwd —
        // same value, accessed through the array length on this
        // surface and a sibling scalar on the others.
        ...manualWithCandidatesField,
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
        ...untargetedListField,
        likelyIrrelevantCriteria: withTitles(likelyIrrelevant, session),
        // Renamed from "automatedGaps" — agents consistently misread
        // that as "criteria automation can't cover" when it actually
        // listed automated criteria that are currently failing. The
        // field used to be a union of every non-info emission,
        // conflating `error`-severity blockers with `warning`-severity
        // nudges under a label that reads as test-runner fail/pass
        // (per `docs/kb/architecture/ai-first-consumer.md`
        // §"Heuristic-mislabeled meta sub-fields are dishonest" — the
        // honest-label rule applies to top-level fields too). Now
        // tightened to "criteria with ≥1 error-severity emission";
        // warning-only criteria ride alongside under
        // `warningAutomatedCriteria` so the discriminator info is
        // preserved without flattening the severity distinction.
        failingAutomatedCriteria: withTitles(failingErrorIds, session),
        warningAutomatedCriteria: withTitles(warningOnlyIds, session),
        // Structured summary dict — mirrors `checklist.summary`'s key
        // shape so an agent that reads `summary.actionable.criteria`
        // / `summary.untargetedCriteria` / `summary.likelyIrrelevant`
        // on either surface gets the same path resolution. Pre-fix
        // this field shipped as a prose string while
        // `checklist.summary` shipped as a dict — same field name on
        // sibling tools, two shapes — the canonical "Sibling fields
        // naming the same concept must use one shape" failure mode in
        // `docs/kb/architecture/ai-first-consumer.md`. An agent
        // reading `coverage.summary.actionableManualItems` got
        // `undefined` while the same path on checklist returned the
        // populated count.
        //
        // The prose previously carried under `summary` is demoted to
        // `summary.headline` so human-readable output isn't lost; the
        // agent's structured access path is the dict body. The
        // `(N%)` tail is dropped from `headline` on a zero-file scan
        // (cosmetically precise but materially meaningless) — pair
        // with the `automatedCriteriaPassRate` omission above so the
        // headline and the structured field agree; the
        // `scanned_zero_files` warning code still carries the reason.
        //
        // `actionable.criteria` is the cross-tool canonical count
        // (matches `scan_project.plan.actionableManualItems`,
        // `checklist.summary.actionable.criteria`, and the sibling
        // `actionableManualItems` scalar on this same coverage entry).
        // `automatedCoverage` mirrors checklist's split — two
        // non-overlapping counters (`criteriaWithRulesAllClean` /
        // `criteriaWithoutEligibleInputs`), never summed into a
        // single composite rate per CLAUDE.md §1 "Composite headline
        // counts are dishonest." `automatedCriteriaPassRate` rides
        // alongside under present-when-meaningful semantics so the
        // legacy headline ratio stays accessible for callers that
        // want it (omitted on zero-file scans alongside the
        // top-level field).
        summary: {
          // Two-axis split mirrors `checklist.summary.actionable` —
          // `criteria` (criteria-axis, matches
          // `scan_project.plan.actionableManualItems` and the sibling
          // `actionableManualItems` scalar on this entry) and
          // `candidates` (candidate-axis, matches
          // `checklist.summary.actionable.candidatesUncapped`,
          // `checklist.totalCandidates`, and the sibling
          // `manualCandidatesTotal` scalar on this entry). Naming
          // makes the unit explicit so an agent reading the field
          // does not silently treat one count as the other — per
          // `docs/kb/architecture/ai-first-consumer.md` "Sibling
          // fields naming the same concept must use one shape" the
          // candidate-vs-criteria split is named, not implied.
          actionable: { criteria: withCandidates.length, candidates: manualCandidatesTotal },
          untargetedCriteria: untargeted.length,
          likelyIrrelevant: likelyIrrelevant.length,
          automatedCoverage: {
            standardId: c.standardId,
            criteriaWithRulesAllClean: c.clean,
            criteriaWithoutEligibleInputs: c.untestable,
            ...(passRateMeaningful ? { automatedCriteriaPassRate: c.automatedPassRate } : {}),
          },
          headline: passRateMeaningful
            ? `${c.clean}/${c.evaluated} evaluated automatable criteria passing (${c.automatedPassRate}%)` +
              `${c.untestable > 0 ? `; ${c.untestable} untestable (no applicable input in this scan)` : ""}. ` +
              `Manual review in ${c.standardId}: ${withCandidates.length} actionable items (criteria with grounded candidates), ` +
              `${untargeted.length} untargeted criteria (no candidates the finders could ground), ` +
              `out of ${c.total} criteria in scope` +
              `${likelyIrrelevant.length > 0 ? `; ${likelyIrrelevant.length} media-only criteria are irrelevant to this scan` : ""}. ` +
              `Run the 'checklist' tool for evaluation prompts.`
            : `No files scanned — automated pass rate is not meaningful. ` +
              `Manual review in ${c.standardId}: 0 actionable items, ${untargeted.length} untargeted criteria, ` +
              `out of ${c.total} criteria in scope (would apply once sources are present). ` +
              `See the \`scanned_zero_files\` warning for why the scan root matched no parseable files.`,
        },
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
    //. Surfaced at the
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
      // candidate union is load-bearing per-
      // MIXED-SIGNAL — a source-text finder (e.g. `review/timing`
      // regex-scanning `ctx.source` even when the AST parse failed) can
      // surface grounded candidates from a file that produced zero
      // rule violations; without the union those files would mis-bucket
      // as `invisible-to-rules` while live candidates reach the caller.
      // Threaded from the shared cross-surface scan helper so the
      // per-bucket assignment agrees with `scan_project` on identical
      // input — not just the totals.
      outputFilePaths,
    );
    // same scan state must
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
    // a coverage response with `criteriaTotalForProfile: 0` /
    // `criteriaAutomatable: 0` etc. is
    // indistinguishable from "tool never ran" unless we surface the
    // honest scan-confidence codes — same input → same labels.
    const configSearchSawProjectMarker =
      projectConfig.sourcePath === null ? sawProjectMarkerInWalk(cwd) : false;
    const filesByExtension = countFilesByExtension(files);
    // Routes through the shared scan-time helper so the warning code
    // set is identical to `scan_project` / `checklist` on the same cwd
    // — cross-surface drift on this channel is a silent-miss failure
    // mode per `docs/kb/architecture/ai-first-consumer.md`
    // "Cross-surface count invariant" (warning-channel extension). The
    // helper internally classifies build artifacts, the SCSS unresolved-
    // variables list, vendor-CSS noise, etc., so callers don't have to
    // duplicate the predicates that previously diverged here.
    //
    // Compute the shared per-rule-coverage rows BEFORE the warnings
    // call so the `metaArrayTruncatedFields` payload can name
    // `perRuleCoverage` whenever the
    // {@link PER_RULE_COVERAGE_CAP} head-slice fired. Cross-surface
    // count invariant per `docs/kb/architecture/ai-first-consumer.md` —
    // every project-rooted tool emits the same `meta.perRuleCoverage`
    // row set on identical input.
    const violationFilePathsForCascade = new Set<string>(
      result.violations.map((v) => v.location.filePath),
    );
    const extensionsProbe = await probeExtensionsPresentAtRoot({
      cwd,
      perRuleCoverage,
      activeRules,
    });
    const sharedPerRuleCoverage: SharedPerRuleCoverageMetaResult = buildSharedPerRuleCoverageMeta({
      perRuleCoverage,
      parsedFiles: files,
      activeRules,
      violationFilePaths: violationFilePathsForCascade,
      ...(extensionsProbe.extensionsPresentAtRoot === undefined
        ? {}
        : { extensionsPresentAtRoot: extensionsProbe.extensionsPresentAtRoot }),
      verboseMeta,
    });
    const metaTruncatedFields: string[] = [];
    if (analysisCoverageField.metaArrayTruncated === true) {
      metaTruncatedFields.push("analysisCoverage.fragmentFiles");
    }
    if (sharedPerRuleCoverage.fragment.perRuleCoverageTruncated !== undefined) {
      metaTruncatedFields.push("perRuleCoverage");
    }
    const scanTime = buildScanTimeWarnings({
      parsedFiles: files,
      violations: result.violations,
      root: cwd,
      configSource: projectConfig.sourcePath,
      configSearchSawProjectMarker,
      rootSource: null,
      analysisCoverage: analysisCoverageField.analysisCoverage,
      filesByExtension,
      jsInnerHtmlDeclinedCount,
      ...(jsInnerHtmlPatternSamples.size === 0 ? {} : { jsInnerHtmlPatternSamples }),
      // Q-SHARED-META-ARRAY-BUDGET-CAP: propagate truncation so the
      // response-level `response_meta_truncated` code fires AND its
      // `warningsDetails.response_meta_truncated.fields` payload names
      // the structured fields elided. Two array surfaces participate
      // on `coverage`: `analysisCoverage.fragmentFiles` (clipped under
      // the shared meta-array cap) and `perRuleCoverage` (the per-rule
      // meta surface introduced when this tool started emitting the
      // shared row set; clipped under {@link PER_RULE_COVERAGE_CAP}).
      // Build the field list from whichever caps actually fired so the
      // payload names exactly the dotted paths the agent should
      // re-fetch under `verboseMeta: true` or scope down on.
      ...(metaTruncatedFields.length > 0 ? { metaArrayTruncatedFields: metaTruncatedFields } : {}),
    });
    // every tool that runs the scanner
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
      filesWithAnyRuleEvaluated,
      configSource: projectConfig.sourcePath,
      scannedEnvelope,
      rulesEvaluated: buildRulesEvaluated({
        loadedCount: activeRules.length,
        perRuleCoverage: sharedPerRuleCoverage.adjustedPerRuleCoverage,
      }),
      perRuleCoverageFragment: sharedPerRuleCoverage.fragment,
      // Lifted onto `meta` here per
      // `docs/kb/architecture/ai-first-consumer.md` "Sibling fields naming
      // the same concept must use one shape" — `buildArtifactsMetaField`
      // is the canonical grouped/decorated shape of the per-file build-
      // artifact classification. The `meta.scannedBuildArtifacts` slot
      // mirrors the shape `scan_project` and `scan_file` already lift
      // from the same helper, closing the cross-surface lane drift on
      // identical cwd. Pre-fix, this tool spread the entire helper-
      // result object at the top level of the response, leaking three
      // sibling empty containers (`buildArtifactEntries: []`,
      // `buildArtifactsMetaField: {}`, `scssUnresolvedVariableFiles: []`)
      // for the same conceptual "absent on this corpus" state.
      buildArtifactsMetaField: scanTime.buildArtifactsMetaField,
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
      // `manualWithCandidates` is present-when-meaningful — it is
      // conditional-spread off the entry when empty so the omit-
      // empty rule on the wire shape stays honest. The route
      // predicate ("non-empty → checklist") collapses to the same
      // reading by treating the absent field as zero. Pre-compute
      // here so the inline `buildCoverageNextStep` call stays free
      // of optional-chain noise (and the handler's cognitive-
      // complexity score stays bounded).
      const manualWithCandidatesLen = readManualWithCandidatesLen(entry);
      const nextStep = entry
        ? buildCoverageNextStep({
            manualWithCandidatesLen,
            // Sum the two severity-split lanes so the route still
            // fires when the only emissions are `warning`-severity —
            // an agent that ignores warning-only criteria would still
            // miss real findings the rule emitted, so `scan_project`
            // is the honest next call either way.
            failingAutomatedLen:
              entry.failingAutomatedCriteria.length + entry.warningAutomatedCriteria.length,
            cwd,
            standard: strParam(params, "standard"),
            level: strParam(params, "level"),
          })
        : {};
      const fullResponse: Record<string, unknown> = {
        ...entry,
        ...nextStep,
        // `coverage` runs a real
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
        ...selectScanTimeWireFields(scanTime),
      };
      // last-resort
      // hard-ceiling guard. After every other clip pass settled
      // (per-rule-coverage cap, meta-array cap), the assembled
      // response can still be over the MCP host's ~25 k-token wall on
      // bulk-vendor corpora — `meta.perRuleCoverage` (one row per
      // loaded rule) * `analysisCoverage.fragmentFiles` *
      // `meta.filesByExtension` inflates independent of any single
      // surface's cap. When the post-build envelope crosses the hard
      // ceiling, degrade to the minimum-honest envelope rather than
      // letting the host drop the response (the canonical
      // oversize-success-is-ambiguous-failure shape per doctrine).
      // Per "Per-tool lane and warning-set classification must agree"
      // — same warning code (`response_dropped_files_oversize`) and
      // same byte-arithmetic payload as `scan_project` / `scan_file`
      // / `checklist`.
      const budgeted = applyCoverageBudget({ response: fullResponse });
      return textResult(budgeted.response);
    }
    return textResult(entries);
  },
};

/**
 * Assembles the `meta` field for `coverage`.-
 * MISSING +: every tool that
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

/**
 * Up-front type validation for the `coverage` handler. Closes the
 * silent-drop class for `paths` / `showUntargeted` / `verboseMeta` —
 * wrong-type inputs used to fall through to defaults, leaving the
 * agent's intent unhonored without any surface signal. Mirrors the
 * closure pattern in `configure-opts.ts.allowWrite`.
 */
function validateCoverageParamTypes(params: Record<string, unknown>): StructuredError | undefined {
  const showUntargeted = requireBooleanParam(params, "showUntargeted");
  if (!showUntargeted.ok) return showUntargeted.error;
  const verboseMeta = requireBooleanParam(params, "verboseMeta");
  if (!verboseMeta.ok) return verboseMeta.error;
  const paths = requireStringArrayParam(params, "paths");
  if (!paths.ok) return paths.error;
  return undefined;
}

function buildCoverageMetaField(args: {
  readonly params: Record<string, unknown>;
  readonly session: McpSession;
  readonly filesScanned: number;
  /**
   * Threaded from {@link import("../engine/scanner.ts").ScanProducts.filesWithAnyRuleEvaluated}
   * so the file-reach split (`filesWithAnyRuleEvaluated` +
   * `filesWithZeroRuleEvaluation`) ships alongside `filesScanned` on
   * every project-rooted tool — `scan_project`, `coverage`,
   * `checklist` — for the cross-surface count invariant. See
   * `docs/kb/architecture/ai-first-consumer.md` "Cross-surface count
   * invariant" + "Composite headline counts are dishonest."
   */
  readonly filesWithAnyRuleEvaluated: number;
  readonly configSource: string | null;
  readonly scannedEnvelope: ScannedEnvelope;
  readonly rulesEvaluated: RulesEvaluated;
  /**
   * Pre-built per-rule-coverage meta fragment from the shared cascade
   * helper ({@link buildSharedPerRuleCoverageMeta}). Spread directly
   * into `fullMeta` so the `coverage` tool emits the same
   * `perRuleCoverage` (verbose) / `perRuleCoverageSummary` (default) /
   * `rulesNotEvaluatedDueToInputType` shape `scan_project` /
   * `scan_file` ship — cross-surface count invariant per
   * `docs/kb/architecture/ai-first-consumer.md`. Before this seam, the
   * `verboseMeta` input description on `coverage` promised the rows
   * but the tool never actually emitted them, while `scan_file` on the
   * same input shipped ~95 rows.
   */
  readonly perRuleCoverageFragment: import("./scan-assembly.ts").PerRuleCoverageMetaFragment;
  /**
   * Grouped build-artifact classification fragment threaded from
   * {@link buildScanTimeWarnings} so the canonical
   * `meta.scannedBuildArtifacts` slot ships on `coverage` the same
   * shape `scan_project` and `scan_file` already surface. Per
   * `docs/kb/architecture/ai-first-consumer.md` "Sibling fields naming
   * the same concept must use one shape" — one canonical surface for
   * per-file build-artifact classification, consumed by every project-
   * rooted tool through this single channel. The fragment itself is
   * `{ scannedBuildArtifacts?: BuildArtifactsGrouped }`, present-when-
   * meaningful — empty when the corpus has zero classified artifacts,
   * collapsing the field name out of the response (no empty-object
   * sentinel).
   */
  readonly buildArtifactsMetaField: {
    readonly scannedBuildArtifacts?: import("./build-artifacts.ts").BuildArtifactsGrouped;
  };
  readonly enabledStandards: readonly string[];
  readonly level: "A" | "AA" | "AAA";
  readonly cwd: string;
}): { readonly meta: Record<string, unknown> } {
  const callerCwd =
    typeof args.params["cwd"] === "string" ? (args.params["cwd"] as string) : undefined;
  const fullMeta: Record<string, unknown> = {
    cwd: args.cwd,
    filesScanned: args.filesScanned,
    filesWithAnyRuleEvaluated: args.filesWithAnyRuleEvaluated,
    filesWithZeroRuleEvaluation: Math.max(0, args.filesScanned - args.filesWithAnyRuleEvaluated),
    scanned: args.scannedEnvelope,
    configSource: args.configSource,
    // the shared helper omits
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
    // `perRuleCoverage` (verbose) or `perRuleCoverageSummary` (default)
    // ride at the top of the meta block so an agent can verify which
    // rules ran on which substrates without a separate `scan_project`
    // round trip. The fragment also carries the unconditional
    // `rulesNotEvaluatedDueToInputType` counter — load-bearing
    // scan-confidence telemetry the agent reads to triage which
    // extensions the scan never saw.
    ...args.perRuleCoverageFragment,
    // Canonical surface for the per-file build-artifact classification
    // — `meta.scannedBuildArtifacts: { grouped, classified }` matches
    // the shape `scan_project` / `scan_file` already lift from the same
    // helper. Conditional-spread per the helper's present-when-
    // meaningful contract (the fragment is `{}` when the corpus has
    // zero classified artifacts, so the field name disappears entirely
    // from the response — no empty-object sentinel).
    ...args.buildArtifactsMetaField,
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
 * `criterionId` is the canonical field — matches
 * `checklist.items[].criteria[0]` (length-1 array — the row's owning
 * criterion ID) and the namespaced-id convention used
 * elsewhere across the MCP surface (`wcag22:1.4.3`). The legacy `id`
 * alias was previously emitted alongside `criterionId` (under the
 * `deprecated_field_id_renamed_criterionId` warning code) but was
 * dropped before the alias-acknowledgement window had any
 * shipped consumers — the dual-field shape was itself the canonical
 * "Ambiguous field shapes are dishonest" failure mode (see
 * `docs/kb/architecture/ai-first-consumer.md`): two identical values
 * under different names on every coverage response inflated payloads
 * and forced the agent to disambiguate which name to read.
 */
function withTitles(
  criterionIds: readonly string[],
  session: import("./session.ts").McpSession,
): readonly {
  readonly criterionId: string;
  readonly title: string;
  readonly level: string;
}[] {
  return criterionIds.map((id) => {
    for (const std of session.registry.standards) {
      const c = std.criteria.find((cr) => cr.id === id);
      if (c) return { criterionId: id, title: c.title, level: c.level };
    }
    return { criterionId: id, title: "", level: "" };
  });
}

/**
 * Counts criteria the loaded rule library can statically address per
 * standard, level-narrowed to the requested profile. Registry-derived —
 * a criterion is "automatable" iff at least one rule in `activeRules`
 * satisfies it (directly or via the criteria-equivalence closure). The
 * scanned corpus does not enter the predicate, so narrow vs bulk scans
 * on identical standard/level produce identical counts.
 *
 * Closes Q9-COVERAGE-CRITERIA-AUTOMATABLE-DRIFTS-NARROW-VS-BULK. The old
 * inline formula `c.automatable` from `buildCoverageReport` mixed
 * standard metadata (criterion has `automatable !== "manual"`) with
 * per-scan rule firings (metadata-manual criterion that emitted at
 * least one violation in this corpus). The latter half drifted between
 * narrow and bulk scopes whenever a rule satisfying a metadata-manual
 * criterion fired on the bulk corpus but not the narrow one. Per
 * `docs/kb/architecture/ai-first-consumer.md` "Cross-surface count
 * invariant," counters naming the same concept must agree on the same
 * input — and the conceptually right input here is the standard module
 * + the loaded ruleset, neither of which depends on the file set.
 *
 * Filtering aligns with `buildCoverageReport`'s level filter: criteria
 * whose level rank exceeds the requested level are excluded so the
 * count matches the conformance scope the agent asked for. The
 * registry-derived count delegates to `Registry.rulesIndex.rulesFor`,
 * which already closes over criteria equivalence — a rule satisfying
 * `wcag22:1.4.3` covers the equivalent `section508:1194.22.c` /
 * `en301549:9.1.4.3` for free. `activeRules` (post-config-filter rules)
 * is intersected on top so a user who disabled a rule in
 * `ra11y.config.ts` doesn't see that rule's criteria count as
 * "automatable" in this configuration.
 */
function countAutomatableCriteriaByRegistry(
  registry: Registry,
  activeRules: readonly Rule[],
  level: "A" | "AA" | "AAA",
): ReadonlyMap<string, number> {
  const activeRuleIds = new Set(activeRules.map((r) => r.id));
  const maxLevel = LEVEL_RANKS[level] ?? 3;
  const out = new Map<string, number>();
  for (const standard of registry.standards) {
    let count = 0;
    for (const criterion of standard.criteria) {
      if (criterionLevelExceeds(criterion.level, maxLevel)) continue;
      const rulesForCriterion = registry.rulesIndex.rulesFor(criterion.id);
      const hasActiveRule = rulesForCriterion.some((id) => activeRuleIds.has(id));
      if (hasActiveRule) count += 1;
    }
    out.set(standard.id, count);
  }
  return out;
}

const LEVEL_RANKS: Readonly<Record<string, number>> = { A: 1, AA: 2, AAA: 3, base: 1 };

function criterionLevelExceeds(criterionLevel: string, maxLevel: number): boolean {
  const rank = LEVEL_RANKS[criterionLevel] ?? 3;
  return rank > maxLevel;
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

/**
 * Indexes shipped review candidates by criterion ID with per-criterion
 * counts. Extracted so the handler stays under the lint's cognitive-
 * complexity ceiling. Doctrine: candidates and criteria are
 * categorically different units — sibling counters must say which is
 * which by name (per
 * `docs/kb/architecture/ai-first-consumer.md` "Sibling fields naming
 * the same concept must use one shape").
 */
function buildCandidateCountByCriterion(
  candidates: readonly ReviewCandidate[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    counts.set(c.criterionId, (counts.get(c.criterionId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Sums per-criterion candidate counts over the supplied criterion-ID
 * list. Extracted so the per-entry build inside
 * `entries = coverage.map(...)` stays under the lint's cognitive-
 * complexity ceiling. Returns 0 when the list is empty or no criterion
 * has a counted candidate.
 *
 * Doctrine: `manualCandidatesTotal` is the candidate-axis sibling to
 * `actionableManualItems` (criteria-axis); the value must agree with
 * `checklist.totalCandidates` and
 * `checklist.summary.actionable.candidatesUncapped` on identical cwd
 * via the cross-surface count invariant in
 * `docs/kb/architecture/ai-first-consumer.md`.
 */
function sumCandidatesAcrossCriteria(
  criteriaWithCandidates: readonly string[],
  candidateCountByCriterion: ReadonlyMap<string, number>,
): number {
  let total = 0;
  for (const id of criteriaWithCandidates) {
    total += candidateCountByCriterion.get(id) ?? 0;
  }
  return total;
}

/**
 * Indexes the criteria touched by ≥1 `error`-severity violation so the
 * `failingAutomatedCriteria` field at the tool boundary can be tightened
 * to error-only emissions. Warning-severity emissions are excluded by
 * design — they ride alongside under `warningAutomatedCriteria` via
 * {@link splitFailingByErrorPresence} so the response carries
 * discriminator info instead of conflating severities under one label.
 *
 * Internal `PerStandardCoverage.failingCriteria` shape is unchanged
 * (still "every non-info emission") because `certification.ts` and the
 * CLI `coverage` command consume it as a union-of-blockers count by
 * design — a warning-severity finding still surfaces as a blocking
 * item there.
 */
function collectErrorSeverityCriteria(violations: readonly Violation[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const violation of violations) {
    if (violation.severity !== "error") continue;
    for (const criterionId of violation.criteria) out.add(criterionId);
  }
  return out;
}

/**
 * Partitions the `PerStandardCoverage.failingCriteria` set (criteria
 * with ≥1 non-info emission) into the two severity-discriminator lanes
 * the tool surface emits:
 *   - `failingErrorIds`: criteria with ≥1 `error`-severity emission;
 *   - `warningOnlyIds`: criteria whose emissions are all
 *     `warning`-severity (no error).
 *
 * The two arrays partition the input — no overlap, no orphans — so a
 * caller summing `failingAutomatedCriteria.length +
 * warningAutomatedCriteria.length` recovers the legacy single-field
 * count exactly.
 */
function splitFailingByErrorPresence(
  failingCriteria: readonly string[],
  errorSet: ReadonlySet<string>,
): { readonly failingErrorIds: readonly string[]; readonly warningOnlyIds: readonly string[] } {
  const failingErrorIds: string[] = [];
  const warningOnlyIds: string[] = [];
  for (const criterionId of failingCriteria) {
    if (errorSet.has(criterionId)) {
      failingErrorIds.push(criterionId);
    } else {
      warningOnlyIds.push(criterionId);
    }
  }
  return { failingErrorIds, warningOnlyIds };
}

/**
 * Builds a `{ [key]: titled }` object when the titled array is
 * non-empty, or an empty object otherwise. Pulls the
 * present-when-meaningful ternary out of the `entries.map` closure
 * so the wire-shape's omit-empty contract stays honest while the
 * map callback's cognitive-complexity score stays bounded.
 *
 * Used for both `untestableCriteria` and `manualWithCandidates` —
 * the two array-form fields whose scalar twins were deleted per
 * `docs/kb/architecture/ai-first-consumer.md` "Sibling fields naming
 * the same concept must use one shape." When the upstream array is
 * empty the field name disappears entirely from the response — an
 * empty-array sentinel would be the dishonest shape the doctrine
 * warns against.
 */
function buildOptionalArrayField<K extends string, V>(
  key: K,
  titled: readonly V[],
): { readonly [P in K]?: readonly V[] } {
  if (titled.length === 0) return {};
  return { [key]: titled } as { readonly [P in K]?: readonly V[] };
}

/**
 * Builds the `untargetedCriteriaList` spread payload conditional on
 * the caller's `showUntargeted` flag. The list rides as a sibling to
 * the always-present `untargetedCriteria` count; pulled into a
 * helper so the entry literal stays free of inline ternaries.
 */
function buildUntargetedListField(
  showUntargeted: boolean,
  titled: ReturnType<typeof withTitles>,
): { readonly untargetedCriteriaList?: ReturnType<typeof withTitles> } {
  if (!showUntargeted) return {};
  return { untargetedCriteriaList: titled };
}

/**
 * Reads the criteria-axis count off an entry's
 * `manualWithCandidates` array, returning 0 when the field was
 * conditionally spread out (the array's length-zero / omit-empty
 * branch). Pulling the optional-chain narrowing into a helper keeps
 * the `handler` closure's cognitive-complexity score bounded.
 */
function readManualWithCandidatesLen(
  entry: { readonly manualWithCandidates?: ReadonlyArray<unknown> } | undefined,
): number {
  if (!entry) return 0;
  const arr = entry.manualWithCandidates;
  return arr === undefined ? 0 : arr.length;
}

/**
 * Extracts the `{ warnings, warningsDetails }` wire surface from the
 * full {@link buildScanTimeWarnings} result. The helper returns four
 * additional fields (`buildArtifactEntries`, `buildArtifactsMetaField`,
 * `scssUnresolvedVariableFiles`) that are internal predicate inputs —
 * `buildArtifactsMetaField` is lifted onto `meta.scannedBuildArtifacts`
 * by {@link buildCoverageMetaField}, and the other two never reach the
 * wire (the SCSS list rides on
 * `warningsDetails.scss_unresolved_variables.files[]` already).
 *
 * Pre-fix, the handler spread the entire helper result, leaking three
 * sibling empty containers at the top level for the same conceptual
 * "absent on this corpus" state — the canonical "Sibling fields naming
 * the same concept must use one shape" failure mode in
 * `docs/kb/architecture/ai-first-consumer.md`. Conditional-spread per
 * the present-when-meaningful contract — codes only appear when at
 * least one fired.
 */
function selectScanTimeWireFields(scanTime: {
  readonly warnings?: readonly import("./warnings.ts").ScanWarningCode[];
  readonly warningsDetails?: import("./warnings.ts").ScanWarningDetails;
}): {
  readonly warnings?: readonly import("./warnings.ts").ScanWarningCode[];
  readonly warningsDetails?: import("./warnings.ts").ScanWarningDetails;
} {
  return {
    ...(scanTime.warnings === undefined ? {} : { warnings: scanTime.warnings }),
    ...(scanTime.warningsDetails === undefined
      ? {}
      : { warningsDetails: scanTime.warningsDetails }),
  };
}
