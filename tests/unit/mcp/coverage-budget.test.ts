/**
 * Unit tests for `applyCoverageBudget` — the oversize-envelope slim
 * fallback for the `coverage` tool. Closes
 * Q14-CHECKLIST-COVERAGE-LACK-MINIMUM-HONEST-ENVELOPE on the coverage
 * surface.
 *
 * Symmetric to `tests/unit/mcp/scan-project-budget-oversize.test.ts`,
 * `tests/unit/mcp/scan-file-budget.test.ts`, and the sibling
 * `tests/unit/mcp/checklist-budget.test.ts` — exercises:
 *
 *   - Pass-through when the response fits under the host ceiling — wire
 *     shape stays byte-identical to the input.
 *   - The slim fallback when the post-build envelope overflows —
 *     `meta.perRuleCoverage` dropped, per-criterion fans dropped,
 *     scalar counters retained, warnings + payload.
 *   - The slim envelope's structured `nextStep` routes to a different
 *     surface (`checklist`) than the failing tool.
 *   - Cross-surface invariant: warning code + payload shape match
 *     scan_project / scan_file / checklist slim paths exactly.
 */

import { describe, expect, it } from "bun:test";
import { applyCoverageBudget } from "../../../src/mcp/coverage-budget.ts";

function buildSyntheticCoverageResponse(
  perRuleRowCount: number,
  options: { metaBloat?: boolean; cwd?: string } = {},
): Record<string, unknown> {
  const perRuleCoverage = Array.from({ length: perRuleRowCount }, (_, i) => ({
    ruleId: `rule/${i}`,
    coverageConfidence: "high",
    fileCount: 1,
  }));
  return {
    standardId: "wcag22",
    criteriaTotalForProfile: 50,
    criteriaByLevel: { A: 30, AA: 20 },
    criteriaAutomatable: 40,
    criteriaAutomatablePassing: 40,
    criteriaEvaluated: 40,
    criteriaClean: 40,
    criteriaWithFindings: 0,
    // The `criteriaUntestable` and `actionableManualItems` scalar
    // twins were dropped from the live coverage entry — the
    // criteria-axis count rides via `summary.actionable.criteria`
    // and `manualWithCandidates.length`; the untestable count rides
    // via `summary.automatedCoverage.criteriaWithoutEligibleInputs`
    // and `untestableCriteria.length`. The top-level twins for
    // `automatedCriteriaPassRate`, `manualCandidateEmissionsTotal`,
    // `untargetedCriteriaForProject`, and `scanned` were dropped under
    // the same closure (each duplicated a `summary.*` value or
    // `meta.scanned`). Synthetic fixture stays aligned with the live
    // wire shape.
    untargetedCriteriaList: [{ criterionId: "wcag22:1.4.1", title: "Use of Color", level: "A" }],
    manualWithCandidates: [
      { criterionId: "wcag22:1.3.1", title: "Info and Relationships", level: "A" },
    ],
    untestableCriteria: [],
    likelyIrrelevantCriteria: [],
    failingAutomatedCriteria: [],
    warningAutomatedCriteria: [],
    // Structured `summary` dict mirrors `checklist.summary`'s shape.
    // The slim envelope spreads `original` first, so the dict survives
    // verbatim.
    summary: {
      actionable: { criteria: 5 },
      untargetedCriteriaForProject: 5,
      likelyIrrelevant: 0,
      automatedCoverage: {
        standardId: "wcag22",
        criteriaWithRulesAllClean: 40,
        criteriaWithoutEligibleInputs: 0,
        automatedCriteriaPassRate: 100,
      },
      headline: "40/40 evaluated automatable criteria passing.",
    },
    nextStep: "Call checklist for actionable items.",
    nextStepStructured: { tool: "checklist", args: { cwd: options.cwd ?? "/tmp/test" } },
    analysisCoverage: {
      filesByExtension: { ".tsx": perRuleRowCount },
      parseErrorFiles: [],
    },
    meta: {
      tool: "coverage",
      version: "0.1.0",
      standards: ["wcag22"],
      level: "AA",
      filesScanned: perRuleRowCount,
      durationMs: 5,
      configSource: null,
      cwd: options.cwd ?? "/tmp/test",
      scanned: { kind: "project", root: options.cwd ?? "/tmp/test" },
      perRuleCoverage,
      ...(options.metaBloat ? { bloatedField: "y".repeat(200_000) } : {}),
    },
  };
}

describe("applyCoverageBudget — pass-through under ceiling", () => {
  it("returns the response unchanged when envelope fits under host ceiling", () => {
    const response = buildSyntheticCoverageResponse(5);
    const result = applyCoverageBudget({ response });
    // Pass-through preserves the input reference (no clone) when the
    // slim guard didn't fire.
    expect(result.response).toBe(response);
    expect(result.truncated).toBe(false);
  });
});

describe("applyCoverageBudget — slim fallback fires on oversize envelope", () => {
  it("degrades to minimum-honest envelope when meta exceeds host ceiling", () => {
    // Force the over-ceiling regime by stuffing meta with a synthetic
    // bloat field. The slim path drops perRuleCoverage and the
    // per-criterion fans, ships the warning code + payload.
    const response = buildSyntheticCoverageResponse(10, {
      metaBloat: true,
      cwd: "/tmp/example-project",
    });
    const result = applyCoverageBudget({ response });
    expect(result.truncated).toBe(true);
    const slim = result.response as Record<string, unknown>;
    // The slim shape keeps scalar counters + `summary` + slimmed `meta`
    // + `nextStep` + the warnings channel. Per-criterion fans drop.
    // The `actionableManualItems` and `criteriaUntestable` scalar
    // twins are no longer shipped on the live envelope, so the slim
    // path no longer retains them either — the criteria-axis count
    // is read off `summary.actionable.criteria`.
    expect(slim.actionableManualItems).toBeUndefined();
    expect(slim.criteriaUntestable).toBeUndefined();
    expect((slim.summary as { actionable: { criteria: number } }).actionable.criteria).toBe(5);
    // Top-level twins for the four nested concepts must NOT ship in
    // the slim envelope either — the slim spreads `original` first,
    // and `original` no longer carries them.
    expect(slim.untargetedCriteriaForProject).toBeUndefined();
    expect(slim.automatedCriteriaPassRate).toBeUndefined();
    expect(slim.manualCandidateEmissionsTotal).toBeUndefined();
    expect(slim.scanned).toBeUndefined();
    // Counts ride through the structured `summary.*` block.
    expect(
      (slim.summary as { untargetedCriteriaForProject: number }).untargetedCriteriaForProject,
    ).toBe(5);
    expect(slim.criteriaAutomatable).toBe(40);
    expect(slim.criteriaEvaluated).toBe(40);
    expect(slim.criteriaClean).toBe(40);
    expect(slim.summary).toBeDefined();
    expect(slim.truncated).toBe(true);
    // Per `docs/kb/architecture/ai-first-consumer.md` "Truncation
    // reporters must reconcile across warnings": no third top-level
    // scalar reporter — the canonical meta-drop detail rides on
    // `warningsDetails.response_dropped_files_oversize.metaFieldsDropped`
    // (asserted below). A sibling boolean would force the agent to
    // reconcile two reporters describing the same event.
    expect(slim.metaFieldDropped).toBeUndefined();
    // Per-criterion / per-rule fans dropped — agent recovers via
    // narrower scope or a checklist call.
    expect(slim.untargetedCriteriaList).toBeUndefined();
    expect(slim.manualWithCandidates).toBeUndefined();
    expect(slim.untestableCriteria).toBeUndefined();
    expect(slim.likelyIrrelevantCriteria).toBeUndefined();
    expect(slim.failingAutomatedCriteria).toBeUndefined();
    expect(slim.warningAutomatedCriteria).toBeUndefined();
    expect(slim.analysisCoverage).toBeUndefined();
    // Warnings channel carries the structured code + payload.
    const warnings = slim.warnings as readonly string[];
    expect(warnings).toContain("response_dropped_files_oversize");
    const details = slim.warningsDetails as Record<string, unknown>;
    const dropPayload = details["response_dropped_files_oversize"] as {
      preDropBytes: number;
      hardCeilingBytes: number;
      droppedFileCountFromRequestedLimit: number;
      totalFilesWithFindings: number;
      metaFieldsDropped?: readonly string[];
    };
    expect(dropPayload).toBeDefined();
    expect(dropPayload.preDropBytes).toBeGreaterThan(dropPayload.hardCeilingBytes);
    expect(dropPayload.hardCeilingBytes).toBeGreaterThan(0);
    // perRuleCoverage row count rides as the dropped counter — the
    // canonical bloat surface for this tool.
    expect(dropPayload.droppedFileCountFromRequestedLimit).toBe(10);
    expect(dropPayload.totalFilesWithFindings).toBe(10);
    // `metaFieldsDropped` names the bloat field + perRuleCoverage that
    // the slim builder discarded.
    expect(dropPayload.metaFieldsDropped).toBeDefined();
    expect(dropPayload.metaFieldsDropped).toContain("bloatedField");
    expect(dropPayload.metaFieldsDropped).toContain("perRuleCoverage");
    // The slim meta dropped perRuleCoverage + bloat field; only known
    // scan-confidence keys survive.
    const meta = slim.meta as Record<string, unknown>;
    expect(meta).not.toHaveProperty("perRuleCoverage");
    expect(meta).not.toHaveProperty("bloatedField");
    expect(meta.tool).toBe("coverage");
    expect(meta.version).toBe("0.1.0");
    expect(meta.filesScanned).toBe(10);
    expect(meta.cwd).toBe("/tmp/example-project");
  });

  it("falls back to propose_config({}) when neither narrowingDir nor cwd is supplied", () => {
    // Last-resort fallback per Q16-PROPOSE-CONFIG-NEXTSTEP-DOES-NOT-NARROW:
    // when no scope evidence flowed through to the helper, the slim
    // envelope routes at `propose_config` with empty args — propose_config
    // resolves its own scan root from the spawn directory. Still cycle-
    // safe (NOT routed at the sibling `checklist`/`coverage` that would
    // re-trigger the slim guard) but acknowledged as the worst routing
    // decision available. The call site is expected to supply `cwd`
    // (and ideally a `narrowingDir`) so this branch fires only on
    // helper-direct invocations without context.
    const response = buildSyntheticCoverageResponse(10, {
      metaBloat: true,
    });
    const result = applyCoverageBudget({ response });
    const slim = result.response as Record<string, unknown>;
    expect(typeof slim.nextStep).toBe("string");
    expect((slim.nextStep as string).length).toBeGreaterThan(0);
    const structured = slim.nextStepStructured as {
      tool: string;
      args: Record<string, unknown>;
    };
    expect(structured).toBeDefined();
    expect(structured.tool).toBe("propose_config");
    expect(structured.args).toEqual({});
    expect(structured.tool).not.toBe("coverage");
    expect(structured.tool).not.toBe("checklist");
  });

  it("routes to propose_config({cwd}) when only cwd is supplied (no narrowing dir)", () => {
    // Q16 closure step 2: when the caller's `cwd` is known but no
    // dominant non-vendor top-level directory was honestly derivable
    // (every top dir vendor-classified, files all sit at root, top-
    // dir tally ties), the slim envelope routes to `propose_config`
    // WITH cwd. Strictly narrower than `propose_config({})` — the
    // agent gets a deterministic re-scan target without re-deriving
    // cwd.
    const response = buildSyntheticCoverageResponse(10, {
      metaBloat: true,
    });
    const result = applyCoverageBudget({
      response,
      cwd: "/tmp/example-project",
    });
    const structured = (result.response as Record<string, unknown>).nextStepStructured as {
      tool: string;
      args: Record<string, unknown>;
    };
    expect(structured.tool).toBe("propose_config");
    expect(structured.args).toEqual({ cwd: "/tmp/example-project" });
    expect(structured.tool).not.toBe("coverage");
    expect(structured.tool).not.toBe("checklist");
  });

  it("routes to scan_project({restrictToPaths,cwd}) when narrowingDir + cwd are supplied", () => {
    // Q16 closure step 1: when the call site identified a dominant
    // non-vendor top-level directory in the corpus, the slim envelope
    // routes the agent at `scan_project({restrictToPaths:
    // [narrowingDir], cwd})` directly — the most direct scope-
    // narrowing call available. Skips the `propose_config` round-
    // trip entirely. Mirrors `scan_project`'s bulk-vendor scope-down
    // override so the slim envelope's recovery path stays identical
    // across project-rooted tools per "Per-tool lane and warning-set
    // classification must agree."
    const response = buildSyntheticCoverageResponse(10, {
      metaBloat: true,
    });
    const result = applyCoverageBudget({
      response,
      narrowingDir: "src",
      cwd: "/tmp/example-project",
    });
    const structured = (result.response as Record<string, unknown>).nextStepStructured as {
      tool: string;
      args: Record<string, unknown>;
    };
    expect(structured.tool).toBe("scan_project");
    expect(structured.args).toEqual({
      restrictToPaths: ["src"],
      cwd: "/tmp/example-project",
    });
    // Cycle-break invariant still holds.
    expect(structured.tool).not.toBe("coverage");
    expect(structured.tool).not.toBe("checklist");
  });
});

describe("applyCoverageBudget — custom hardCeilingChars (test ergonomics)", () => {
  it("triggers slim path under a small synthetic ceiling", () => {
    const response = buildSyntheticCoverageResponse(50, {
      cwd: "/tmp/example-project",
    });
    const result = applyCoverageBudget({ response, hardCeilingChars: 1000 });
    expect(result.truncated).toBe(true);
    const slim = result.response as Record<string, unknown>;
    expect((slim.meta as Record<string, unknown>).perRuleCoverage).toBeUndefined();
    const warnings = slim.warnings as readonly string[];
    expect(warnings).toContain("response_dropped_files_oversize");
  });
});
