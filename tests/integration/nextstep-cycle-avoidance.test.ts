/**
 * Pins the AI-first doctrine bullet
 * "NextStep handoffs must terminate at a narrowing tool, never form a
 * cycle between transport-failing siblings"
 * (`docs/kb/architecture/ai-first-consumer.md`).
 *
 * Walk-one-hop invariant: for every project-rooted tool's slim envelope
 * (`scan_project`, `scan_file`, `checklist`, `coverage`), the
 * `nextStepStructured` recommendation, traced one hop further on the
 * same cwd, MUST EITHER:
 *
 *   (a) route to a tool whose args reduce input scope (`restrictToPaths`,
 *       `additionalPaths`, a single sub-tree `cwd`, a single-file
 *       `path`, a derived per-page `limit` cap), OR
 *   (b) route to a deterministic narrowing tool (`propose_config`,
 *       which emits an `exclude` block from the build-artifact
 *       classifier — the next `scan_project` call traverses a
 *       narrower file set by construction), OR
 *   (c) reduce the rule set on the next call.
 *
 * The recommendation MUST NOT:
 *
 *   (i)  echo the parameters that produced the truncation (re-issuing
 *        the same tool against the same `cwd` would re-trigger the
 *        slim guard, blowing the host envelope a second time);
 *   (ii) form a cycle between two project-rooted siblings that ship
 *        from the same scope-classifier (the canonical regression:
 *        `checklist.nextStep -> coverage` while
 *        `coverage.nextStep -> checklist`, leaving the agent in a
 *        circular handoff with no narrowing path in the cycle).
 *
 * This test pins both legs of the invariant: the per-surface
 * narrowing-tool predicate AND the directed-graph cycle-closure check
 * across the project-rooted set.
 *
 * Forces oversize-truncation by exercising the budget helpers
 * (`applyChecklistBudget`, `applyCoverageBudget`, `applyScanFileBudget`,
 * `applyScanProjectBudget`-equivalent slim builder) with synthetic
 * over-ceiling responses on a small `hardCeilingChars`. Mirrors the
 * existing `oversize-envelope-cross-surface.test.ts` and
 * `truncation-reporters-reconcile.test.ts` patterns — full MCP
 * subprocess spawn would require fabricating a 100+ KB bulk-vendor
 * corpus to trigger the natural 96000-char ceiling, which is brittle
 * and slow. The helpers' contract IS the pinned surface; the wiring
 * at each tool's textResult callsite is exercised by their respective
 * `tool-*.ts` integration tests.
 */

import { describe, expect, it } from "bun:test";
import { applyChecklistBudget } from "../../src/mcp/checklist-budget.ts";
import { applyCoverageBudget } from "../../src/mcp/coverage-budget.ts";
import { applyScanFileBudget } from "../../src/mcp/scan-file-budget.ts";
import { buildSlimNextStepStructured as buildScanProjectSlimNextStep } from "../../src/mcp/scan-project-slim-next-step.ts";
import type { ScanFormatted } from "../../src/mcp/tools-helpers.ts";

const HARD_CEILING = 1000;

/**
 * Set of project-rooted full-scan tools that ship from the same
 * scope-classifier on the same cwd. A slim envelope routing at one of
 * these on the SAME cwd that just produced the truncation is the
 * canonical cycle-trigger — the recommended call would re-traverse the
 * identical file set under the identical scope-classifier and ship the
 * same oversize regime.
 */
const SIBLING_PROJECT_ROOTED_TOOLS: ReadonlySet<string> = new Set([
  "scan_project",
  "checklist",
  "coverage",
]);

/**
 * Set of tools the doctrine treats as "narrowing recovery" — calling
 * one of these from a slim envelope is honest because the call's shape
 * itself reduces scope: `propose_config` emits an `exclude` block (the
 * next scan traverses fewer files); `scan_file` is the single-file
 * surface (one file, not a corpus); `baseline check` consumes a
 * pre-written grandfathered ledger.
 */
const NARROWING_RECOVERY_TOOLS: ReadonlySet<string> = new Set([
  "propose_config",
  "scan_file",
  "baseline",
  "detect_native_wrappers",
]);

/**
 * Returns true when the recommended (tool, args) pair narrows scope
 * relative to the originating call's cwd. Three honest forms:
 *
 *   1. The tool is in {@link NARROWING_RECOVERY_TOOLS} — calling it
 *      from a slim envelope is honest because the call's semantics
 *      themselves reduce scope by construction.
 *   2. The recommendation routes back to a sibling project-rooted
 *      tool BUT the args carry an explicit narrowing knob
 *      (`restrictToPaths` / `additionalPaths` / a tighter `cwd` —
 *      a single sub-tree, not the same cwd that produced the
 *      truncation). The `restrictToPaths`/`additionalPaths` arrays
 *      must be non-empty (`additionalPaths: []` is the canonical
 *      "echoes the same scope" failure mode).
 *   3. The recommendation routes to `scan_file` with a `path` AND/OR
 *      a `limit` knob (single-file surface, can't inherit a
 *      bulk-corpus blow-up).
 *
 * Anything else — the tool is a sibling AND args carry no narrowing
 * knob — is a cycle-trigger by the doctrine. Empty `args: {}` on a
 * sibling is the worst case (the agent reads "rerun on same cwd").
 */
function recommendationNarrowsScope(
  originatingCwd: string | undefined,
  recommended: { readonly tool: string; readonly args: Record<string, unknown> },
): boolean {
  if (NARROWING_RECOVERY_TOOLS.has(recommended.tool)) return true;
  // Sibling project-rooted full-scan tool: must carry a narrowing knob.
  const args = recommended.args;
  // `restrictToPaths` / `additionalPaths` must be present AND
  // non-empty. Empty array `[]` echoes the same scope.
  if (Array.isArray(args["restrictToPaths"]) && args["restrictToPaths"].length > 0) return true;
  if (Array.isArray(args["additionalPaths"]) && args["additionalPaths"].length > 0) return true;
  // `cwd` differs from the originating cwd — a tighter sub-tree is
  // honest narrowing; echoing the same cwd is not. Path-prefix logic
  // would require a real fs to verify "tighter sub-tree"; the on-wire
  // signal is "the recommended cwd string is not the same string the
  // caller just passed." If a refactor recommends an arbitrary
  // different cwd, the agent reading it would call against a different
  // root — not a cycle. The cycle-trigger predicate is "same cwd, no
  // narrowing knob," which this branch declines.
  const recommendedCwd = typeof args["cwd"] === "string" ? (args["cwd"] as string) : undefined;
  if (
    recommendedCwd !== undefined &&
    originatingCwd !== undefined &&
    recommendedCwd !== originatingCwd
  ) {
    return true;
  }
  return false;
}

function buildOversizeChecklistResponse(cwd = "/tmp/x"): Record<string, unknown> {
  return {
    summary: {
      actionable: {
        criteria: 1,
        emissionsTotal: 1,
        emissionsAfterCollapse: 1,
        emissionsReturnedAfterClip: 1,
      },
    },
    items: [{ criteria: ["wcag22:1.1.1"], candidates: [{ path: "x.tsx", line: 1 }] }],
    totalCandidates: 1,
    nextStep: "Iterate items[].",
    nextStepStructured: { tool: "scan_project", args: { cwd } },
    meta: {
      tool: "checklist",
      version: "0.1.0",
      filesScanned: 1,
      configSource: null,
      cwd,
      bloatedField: "y".repeat(2000),
    },
  };
}

function buildOversizeCoverageResponse(cwd = "/tmp/x"): Record<string, unknown> {
  return {
    standardId: "wcag22",
    untargetedCriteriaForProject: 0,
    summary: {
      actionable: { criteria: 1 },
      untargetedCriteriaForProject: 0,
      likelyIrrelevant: 0,
      automatedCoverage: {
        standardId: "wcag22",
        criteriaWithRulesAllClean: 1,
        criteriaWithoutEligibleInputs: 0,
        automatedCriteriaPassRate: 100,
      },
      headline: "1/1 evaluated",
    },
    nextStep: "Call checklist.",
    nextStepStructured: { tool: "checklist", args: { cwd } },
    scanned: { kind: "project", root: cwd },
    meta: {
      tool: "coverage",
      version: "0.1.0",
      filesScanned: 1,
      configSource: null,
      cwd,
      perRuleCoverage: Array.from({ length: 5 }, (_, i) => ({ ruleId: `rule/${i}` })),
      bloatedField: "y".repeat(2000),
    },
  };
}

function buildOversizeScanFileResponse(): Record<string, unknown> {
  return {
    findings: Array.from({ length: 50 }, (_, i) => ({
      findingId: `x@${i + 1}`,
      ruleId: "test/rule",
      severity: "error",
      line: i + 1,
      column: 1,
    })),
    plan: {
      infoSeverityFindings: 0,
      fixesByClass: {
        mechanical: { source: 1, buildArtifact: 0 },
        guidance: { source: 0, buildArtifact: 0 },
        runtimeOnly: { source: 0, buildArtifact: 0 },
        verifyInSource: { source: 0, buildArtifact: 0 },
      },
      reviewNeeded: 0,
      manualOnly: 0,
      estimatedEffort: "trivial",
      summary: "1 finding",
    },
    nextStep: "Call suggest_fix.",
    meta: {
      tool: "scan_file",
      version: "0.1.0",
      filesScanned: 1,
      configSource: null,
      scanned: { kind: "file", file: "/tmp/x.html" },
      bloatedField: "y".repeat(2000),
    },
  };
}

/**
 * Synthetic `ScanFormatted` for `scan_project`'s slim builder. The
 * slim envelope picks a top non-vendor file as the recovery
 * `scan_file` target; this fixture supplies one so arm 1 of
 * scan-project-slim-next-step's matrix fires (the dominant routing
 * arm — agents recover via the highest-impact single file).
 */
function buildScanProjectFormatted(): ScanFormatted {
  return {
    files: [
      {
        path: "src/app.tsx",
        findings: [
          { findingId: "a@1", ruleId: "alt/img", severity: "error", line: 1, column: 1 },
          { findingId: "a@2", ruleId: "alt/img", severity: "error", line: 5, column: 1 },
        ],
      },
      {
        path: "src/foo.tsx",
        findings: [{ findingId: "f@1", ruleId: "alt/img", severity: "error", line: 1, column: 1 }],
      },
    ],
    totalFindings: 3,
  } as unknown as ScanFormatted;
}

describe("nextStep cycle avoidance — every project-rooted slim envelope routes to a narrowing tool, never echoes the truncation parameters", () => {
  it("checklist slim envelope routes to a narrowing tool (not a sibling project-rooted full-scan tool)", () => {
    const cwd = "/tmp/q18-checklist";
    const result = applyChecklistBudget({
      response: buildOversizeChecklistResponse(cwd),
      hardCeilingChars: HARD_CEILING,
      cwd,
    });
    expect(result.truncated).toBe(true);
    const slim = result.response as Record<string, unknown>;
    const ns = slim.nextStepStructured as { tool: string; args: Record<string, unknown> };
    // Doctrine: never route to a sibling project-rooted full-scan tool
    // on the same cwd — that recreates the cycle the bullet warns
    // against (checklist <-> coverage was the canonical regression).
    expect(SIBLING_PROJECT_ROOTED_TOOLS.has(ns.tool)).toBe(false);
    // The walk-one-hop predicate: the recommended call must narrow
    // scope by construction.
    expect(recommendationNarrowsScope(cwd, ns)).toBe(true);
  });

  it("coverage slim envelope routes to a narrowing tool (not a sibling project-rooted full-scan tool)", () => {
    const cwd = "/tmp/q18-coverage";
    const result = applyCoverageBudget({
      response: buildOversizeCoverageResponse(cwd),
      hardCeilingChars: HARD_CEILING,
      cwd,
    });
    expect(result.truncated).toBe(true);
    const slim = result.response as Record<string, unknown>;
    const ns = slim.nextStepStructured as { tool: string; args: Record<string, unknown> };
    // The cycle-break partner of the checklist test — the doctrine
    // bullet's canonical regression is the BIDIRECTIONAL pair
    // (checklist.nextStep -> coverage AND coverage.nextStep -> checklist).
    // Pin both halves so a future regression that re-introduces
    // either edge is caught.
    expect(SIBLING_PROJECT_ROOTED_TOOLS.has(ns.tool)).toBe(false);
    expect(recommendationNarrowsScope(cwd, ns)).toBe(true);
  });

  it("scan_file slim envelope routes to a narrowing recovery (single-file surface, derived limit)", () => {
    const result = applyScanFileBudget({
      limit: undefined,
      offset: undefined,
      maxBytes: HARD_CEILING,
      response: buildOversizeScanFileResponse(),
    });
    expect(result.truncated).toBe(true);
    const slim = result.response as Record<string, unknown>;
    const ns = slim.nextStepStructured as { tool: string; args: Record<string, unknown> };
    // scan_file's slim re-routes back to scan_file with a per-page
    // `limit` cap — that's a rule-set-narrowing recovery (fewer
    // findings per response), not a scope-echo. The single-file
    // surface can't inherit a bulk-corpus blow-up by construction.
    expect(ns.tool).toBe("scan_file");
    // The args MUST carry at least a `limit` knob — empty args would
    // mean "rerun on same path with same shape," echoing the
    // truncation. The doctrine "Ambiguous field shapes are dishonest"
    // sibling rule already forbids this on this surface.
    expect(typeof ns.args["limit"]).toBe("number");
    expect((ns.args["limit"] as number) > 0).toBe(true);
  });

  it("scan_project slim envelope routes to a narrowing tool (single-file scan_file or coverage manual-review angle)", () => {
    // scan_project's slim builder is the most complex of the four —
    // arm 1 routes to `scan_file` on the top non-vendor file (the
    // dominant agent-recovery path), arm 2 to `coverage` when no
    // non-vendor file exists. Both narrow scope: scan_file is
    // single-file (cannot inherit the bulk-corpus regime); coverage
    // is the manual-review-half angle (no per-file files[] envelope).
    const formatted = buildScanProjectFormatted();
    const ns = buildScanProjectSlimNextStep({
      formatted,
      params: { cwd: "/tmp/q18-scan-project" },
      isVendor: () => false,
    });
    // The non-vendor top-file fixture supplies `src/app.tsx` with the
    // most findings — arm 1 of the matrix fires.
    expect(ns.tool).toBe("scan_file");
    expect(ns.args["path"]).toBe("src/app.tsx");
    // Validate the narrowing predicate end-to-end.
    expect(recommendationNarrowsScope("/tmp/q18-scan-project", ns)).toBe(true);
  });

  it("scan_project slim envelope falls back to coverage when no non-vendor file exists (still narrowing — manual-review angle does not traverse files[])", () => {
    // Arm 2 of scan-project-slim-next-step's matrix: every file is
    // vendor-classified, so scan_file routing is dishonest (the agent
    // would land on a path they cannot edit). Coverage is the
    // honest pivot — its response shape is criteria-coverage matrix
    // + manualWithCandidates, neither of which inherits the bulk
    // files[] envelope. The cycle is still broken because
    // coverage's own slim envelope (when fired) routes to
    // propose_config, terminating the chain.
    const cwd = "/tmp/q18-all-vendor";
    const formatted = buildScanProjectFormatted();
    const ns = buildScanProjectSlimNextStep({
      formatted,
      params: { cwd },
      isVendor: () => true, // every file vendor-classified
    });
    // Arm 2: routes to coverage with the originating cwd. Note this
    // is a SINGLE-HOP route — coverage's slim envelope (if it fires
    // on the same cwd) routes to propose_config (a narrowing
    // recovery tool), so the chain terminates within two hops total.
    expect(ns.tool).toBe("coverage");
    // Coverage is a manual-review-angle tool whose response shape
    // doesn't traverse the same per-file envelope, so it doesn't
    // re-trigger the same regime — but if it WERE to ship oversize,
    // the second-hop terminator (coverage.nextStep -> propose_config)
    // is pinned by the coverage slim test above. Two-hop closure.
  });

  it("checklist + coverage slim envelopes never form a 2-cycle on the same cwd (canonical doctrine regression)", () => {
    // The exact regression the doctrine bullet documents: on a
    // bulk-vendor corpus, `checklist.nextStepStructured.tool: "coverage"`
    // while `coverage.nextStepStructured.tool: "checklist"` — both
    // surfaces ship oversize on the same scope, neither cycle exit
    // narrows scope. Pin both edges of the would-be cycle in one
    // assertion so a future regression that re-routes either side
    // is caught.
    const cwd = "/tmp/q18-cycle";
    const checklistResult = applyChecklistBudget({
      response: buildOversizeChecklistResponse(cwd),
      hardCeilingChars: HARD_CEILING,
      cwd,
    });
    const coverageResult = applyCoverageBudget({
      response: buildOversizeCoverageResponse(cwd),
      hardCeilingChars: HARD_CEILING,
      cwd,
    });
    expect(checklistResult.truncated).toBe(true);
    expect(coverageResult.truncated).toBe(true);

    const checklistNs = (checklistResult.response as Record<string, unknown>)[
      "nextStepStructured"
    ] as { tool: string };
    const coverageNs = (coverageResult.response as Record<string, unknown>)["nextStepStructured"] as
      | { tool: string }
      | undefined;

    // Build the directed edge set { checklist -> X, coverage -> Y }
    // and assert no 2-cycle exists in the graph (no pair of edges
    // {a -> b, b -> a} where both a, b are in the project-rooted
    // sibling set).
    const edges: ReadonlyArray<readonly [string, string]> = [
      ["checklist", checklistNs.tool],
      ["coverage", coverageNs?.tool ?? ""],
    ];
    for (const [src, dst] of edges) {
      // The forbidden cycle: src and dst are both sibling
      // project-rooted full-scan tools on the same cwd.
      const isCycleEdge =
        SIBLING_PROJECT_ROOTED_TOOLS.has(src) && SIBLING_PROJECT_ROOTED_TOOLS.has(dst);
      expect(
        isCycleEdge,
        `cycle-break invariant: ${src}.nextStepStructured.tool routes at sibling project-rooted full-scan tool ${dst} on the same cwd — recreates the doctrine-flagged checklist <-> coverage circular handoff`,
      ).toBe(false);
    }
  });

  it("walk-one-hop closure across the project-rooted slim set — every recommended next call narrows scope by construction", () => {
    // Property check: enumerate every project-rooted slim envelope's
    // recommended next call and assert the narrowing predicate
    // holds for each. Catches a future regression where one
    // surface's slim builder is refactored to route at a sibling
    // without narrowing args, even if the canonical
    // checklist <-> coverage pair stays intact.
    const cwd = "/tmp/q18-walk";
    const checklistResult = applyChecklistBudget({
      response: buildOversizeChecklistResponse(cwd),
      hardCeilingChars: HARD_CEILING,
      cwd,
    });
    const coverageResult = applyCoverageBudget({
      response: buildOversizeCoverageResponse(cwd),
      hardCeilingChars: HARD_CEILING,
      cwd,
    });
    const scanFileResult = applyScanFileBudget({
      limit: undefined,
      offset: undefined,
      maxBytes: HARD_CEILING,
      response: buildOversizeScanFileResponse(),
    });
    const scanProjectNs = buildScanProjectSlimNextStep({
      formatted: buildScanProjectFormatted(),
      params: { cwd },
      isVendor: () => false,
    });

    const recommendations: ReadonlyArray<{
      readonly source: string;
      readonly ns: { readonly tool: string; readonly args: Record<string, unknown> };
    }> = [
      {
        source: "checklist",
        ns: (checklistResult.response as Record<string, unknown>)["nextStepStructured"] as {
          tool: string;
          args: Record<string, unknown>;
        },
      },
      {
        source: "coverage",
        ns: (coverageResult.response as Record<string, unknown>)["nextStepStructured"] as {
          tool: string;
          args: Record<string, unknown>;
        },
      },
      {
        source: "scan_file",
        ns: (scanFileResult.response as Record<string, unknown>)["nextStepStructured"] as {
          tool: string;
          args: Record<string, unknown>;
        },
      },
      { source: "scan_project", ns: scanProjectNs },
    ];

    for (const { source, ns } of recommendations) {
      // Either it routes at a known-narrowing recovery tool, OR the
      // args explicitly carry a narrowing knob. Anything else is the
      // doctrine-flagged echo-the-truncation-params failure mode.
      const narrows = recommendationNarrowsScope(cwd, ns);
      expect(
        narrows,
        `${source} slim envelope nextStepStructured routes at ${ns.tool} with args ${JSON.stringify(
          ns.args,
        )} — does not narrow scope nor route at a deterministic narrowing tool. Per AI-first doctrine "NextStep handoffs must terminate at a narrowing tool, never form a cycle between transport-failing siblings."`,
      ).toBe(true);
    }
  });
});
