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
    automatedCriteriaPassRate: 100,
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
    // and `untestableCriteria.length`. Synthetic fixture stays
    // aligned with the live wire shape.
    untargetedCriteria: 5,
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
      untargetedCriteria: 5,
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
    scanned: { kind: "project", root: options.cwd ?? "/tmp/test" },
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
    expect(slim.untargetedCriteria).toBe(5);
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

  it("routes nextStep to propose_config (scope-narrowing tool) when the slim guard fires", () => {
    // Cycle-break invariant per
    // `docs/kb/architecture/ai-first-consumer.md` "NextStep handoffs
    // must terminate at a narrowing tool, never form a cycle between
    // transport-failing siblings": pointing at the sibling
    // project-rooted `checklist` tool (the previous routing) on a
    // bulk-vendor / oversize corpus would echo the same scope-
    // classifier and re-trigger `checklist`'s own slim guard — the
    // canonical circular handoff with no narrowing path. The slim
    // envelope's structured next-call routes to `propose_config`
    // (deterministic exclude-block emission from the build-artifact
    // classifier), so the next `scan_project` call after the agent
    // applies the proposed excludes traverses a narrower file set by
    // construction.
    const response = buildSyntheticCoverageResponse(10, {
      metaBloat: true,
      cwd: "/tmp/example-project",
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
    // `propose_config` resolves its own scan root; including the cwd
    // would echo the same scope that just produced the oversize
    // envelope. Empty args is the honest shape per the doctrine
    // bullet "never echo the parameters that just produced the
    // truncation."
    expect(structured.args).toEqual({});
    // Cycle-break: must NOT route to either project-rooted sibling
    // that ships from the same scope-classifier.
    expect(structured.tool).not.toBe("coverage");
    expect(structured.tool).not.toBe("checklist");
  });

  it("ships empty args even when meta carries cwd (cycle-break invariant)", () => {
    // The cycle-break routing is unconditional — including the cwd
    // would re-echo the scope that produced the truncation.
    const response = buildSyntheticCoverageResponse(10, { metaBloat: true });
    (response.meta as Record<string, unknown>).cwd = undefined;
    const result = applyCoverageBudget({ response });
    const slim = result.response as Record<string, unknown>;
    const structured = slim.nextStepStructured as {
      tool: string;
      args: Record<string, unknown>;
    };
    expect(structured.tool).toBe("propose_config");
    expect(structured.args).toEqual({});
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
