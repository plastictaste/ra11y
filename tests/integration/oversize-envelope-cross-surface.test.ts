/**
 * Cross-surface oversize-envelope parity: when the assembled response
 * exceeds the host token ceiling, `scan_project`, `scan_file`,
 * `checklist`, and `coverage` must all fall back to the same minimum-
 * honest envelope shape — same warning code
 * (`response_dropped_files_oversize`), same payload schema, same
 * truncation semantics. Closes
 * Q14-CHECKLIST-COVERAGE-LACK-MINIMUM-HONEST-ENVELOPE.
 *
 * Doctrine: `docs/kb/architecture/ai-first-consumer.md` "Per-tool lane
 * and warning-set classification must agree":
 *
 *   "The minimum-honest envelope (drop `files[]`, keep
 *    `plan` + `meta` + `warnings` + `nextStep`) implemented at
 *    `scan_project` is absent at `checklist` and `coverage`, so an
 *    oversize bulk-vendor scan succeeds at the project surface and
 *    transport-fails at the manual-review surface."
 *
 * Pre-Q14, the slim envelope was wired only on `scan_project` and
 * `scan_file`; checklist + coverage returned the full assembled
 * response and let the host transport drop it. This test pins the
 * symmetric guard now wired into all four surfaces:
 *
 *   - Same warning code (`response_dropped_files_oversize`).
 *   - Same payload schema (`preDropBytes`, `hardCeilingBytes`,
 *     `droppedFileCountFromRequestedLimit`, `totalFilesWithFindings`,
 *     optional `metaFieldsDropped`).
 *   - Same truncation semantics (`truncated: true` on the slim path).
 *   - Same nextStep cross-routing (slim never re-routes back to the
 *     failing tool).
 *
 * Tests the helpers directly with a small synthetic ceiling — full
 * MCP subprocess spawn would require building a 100+ KB corpus to
 * trigger the natural 96000-char ceiling, which is brittle and slow.
 * The helpers' contract is the pinned surface; the wiring at each
 * tool's textResult callsite is exercised by their respective
 * `tool-*.ts` integration tests.
 */

import { describe, expect, it } from "bun:test";
import { applyChecklistBudget } from "../../src/mcp/checklist-budget.ts";
import { applyCoverageBudget } from "../../src/mcp/coverage-budget.ts";
import { applyScanFileBudget } from "../../src/mcp/scan-file-budget.ts";

interface SlimWarningPayload {
  readonly preDropBytes: number;
  readonly hardCeilingBytes: number;
  readonly droppedFileCountFromRequestedLimit: number;
  readonly totalFilesWithFindings: number;
  readonly metaFieldsDropped?: readonly string[];
}

function readDropPayload(response: Record<string, unknown>): SlimWarningPayload {
  const details = response["warningsDetails"] as Record<string, unknown>;
  return details["response_dropped_files_oversize"] as SlimWarningPayload;
}

function buildOversizeChecklistResponse(): Record<string, unknown> {
  return {
    summary: { actionable: { criteria: 1, candidatesUncapped: 1, candidatesReturned: 1 } },
    items: [{ criteria: ["wcag22:1.1.1"], candidates: [{ path: "x.tsx", line: 1 }] }],
    totalCandidates: 1,
    nextStep: "Iterate items[].",
    nextStepStructured: { tool: "scan_project", args: { cwd: "/tmp/x" } },
    meta: {
      tool: "checklist",
      version: "0.1.0",
      filesScanned: 1,
      configSource: null,
      cwd: "/tmp/x",
      bloatedField: "y".repeat(2000),
    },
  };
}

function buildOversizeCoverageResponse(): Record<string, unknown> {
  return {
    standardId: "wcag22",
    // `actionableManualItems` and `criteriaUntestable` scalars were
    // dropped from the coverage entry (each duplicated its array-
    // form sibling) — the criteria-axis count rides via
    // `summary.actionable.criteria` and the array form
    // `manualWithCandidates`.
    untargetedCriteriaForProject: 0,
    // Structured `summary` dict mirrors `checklist.summary`'s shape.
    // The slim envelope spreads `original` first, so the dict rides
    // through unchanged.
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
    nextStepStructured: { tool: "checklist", args: { cwd: "/tmp/x" } },
    scanned: { kind: "project", root: "/tmp/x" },
    meta: {
      tool: "coverage",
      version: "0.1.0",
      filesScanned: 1,
      configSource: null,
      cwd: "/tmp/x",
      perRuleCoverage: Array.from({ length: 5 }, (_, i) => ({ ruleId: `rule/${i}` })),
      bloatedField: "y".repeat(2000),
    },
  };
}

function buildOversizeScanFileResponse(): Record<string, unknown> {
  return {
    findings: [{ findingId: "x@1", ruleId: "test/rule", severity: "error", line: 1, column: 1 }],
    plan: {
      notes: 0,
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

describe("oversize-envelope cross-surface parity — checklist / coverage / scan_file", () => {
  // Small synthetic ceiling triggers the slim guard on a 2 KB bloat
  // field — the assembled fixtures all serialize over 1000 chars.
  const HARD_CEILING = 1000;

  it("checklist slim envelope ships the canonical warning code + payload schema", () => {
    const result = applyChecklistBudget({
      response: buildOversizeChecklistResponse(),
      hardCeilingChars: HARD_CEILING,
    });
    expect(result.truncated).toBe(true);
    const slim = result.response as Record<string, unknown>;
    const warnings = slim.warnings as readonly string[];
    expect(warnings).toContain("response_dropped_files_oversize");
    const payload = readDropPayload(slim);
    expect(payload.preDropBytes).toBeGreaterThan(payload.hardCeilingBytes);
    expect(payload.hardCeilingBytes).toBe(HARD_CEILING);
    expect(payload.metaFieldsDropped).toContain("bloatedField");
    expect(slim.truncated).toBe(true);
    // Cycle-break invariant per
    // `docs/kb/architecture/ai-first-consumer.md` "NextStep handoffs
    // must terminate at a narrowing tool, never form a cycle between
    // transport-failing siblings": nextStep must not route to either
    // project-rooted sibling tool that ships from the same scope-
    // classifier (the previous routing pointed at `coverage`, which
    // would transport-fail the same way on the same corpus).
    const ns = slim.nextStepStructured as { tool: string };
    expect(ns.tool).not.toBe("checklist");
    expect(ns.tool).not.toBe("coverage");
  });

  it("checklist slim envelope renames items[] to itemsTruncated[] (per truncated-containers doctrine)", () => {
    // Pins the field-rename so an agent reading just `response.items`
    // gets `undefined` instead of the misleading `[]` that used to
    // ship under the original field name. Mirrors the
    // `meta.perRuleCoverageTruncated` / `fragmentFilesTruncated`
    // precedent — the field name itself signals that contents were
    // stripped. Per `docs/kb/architecture/ai-first-consumer.md`
    // "Truncated containers must rename or sentinel, not retain".
    const result = applyChecklistBudget({
      response: buildOversizeChecklistResponse(),
      hardCeilingChars: HARD_CEILING,
    });
    expect(result.truncated).toBe(true);
    const slim = result.response as Record<string, unknown>;
    // The original `items` key MUST be absent from the wire — the
    // canonical regression case the doctrine bullet documents:
    // shipping `items: []` alongside `truncated: true` makes an agent
    // reading just `items` unable to distinguish "no actionable
    // items" from "items array was stripped to fit."
    expect(slim).not.toHaveProperty("items");
    // The renamed field carries the empty array — the rename itself
    // is the field-level signal.
    expect(slim.itemsTruncated).toEqual([]);
    // The companion `truncationReason` names the warning code that
    // owns the byte-arithmetic payload, so an agent has a single
    // string identifier to cross-reference `warningsDetails.<reason>`.
    expect(slim.truncationReason).toBe("response_dropped_files_oversize");
    // The legacy redundant boolean flag was dropped — the field-rename
    // already signals the same fact at the field level. Per "Sibling
    // fields naming the same concept must use one shape".
    expect(slim).not.toHaveProperty("itemsArrayDropped");
  });

  it("coverage slim envelope ships the canonical warning code + payload schema", () => {
    const result = applyCoverageBudget({
      response: buildOversizeCoverageResponse(),
      hardCeilingChars: HARD_CEILING,
    });
    expect(result.truncated).toBe(true);
    const slim = result.response as Record<string, unknown>;
    const warnings = slim.warnings as readonly string[];
    expect(warnings).toContain("response_dropped_files_oversize");
    const payload = readDropPayload(slim);
    expect(payload.preDropBytes).toBeGreaterThan(payload.hardCeilingBytes);
    expect(payload.hardCeilingBytes).toBe(HARD_CEILING);
    expect(payload.metaFieldsDropped).toContain("bloatedField");
    expect(payload.metaFieldsDropped).toContain("perRuleCoverage");
    expect(slim.truncated).toBe(true);
    // perRuleCoverage row count carries on the dropped counter — the
    // canonical bloat surface for this tool.
    expect(payload.droppedFileCountFromRequestedLimit).toBe(5);
    // Cycle-break invariant per
    // `docs/kb/architecture/ai-first-consumer.md` "NextStep handoffs
    // must terminate at a narrowing tool, never form a cycle between
    // transport-failing siblings": nextStep must not route to either
    // project-rooted sibling tool that ships from the same scope-
    // classifier (the previous routing pointed at `checklist`, which
    // would transport-fail the same way on the same corpus).
    const ns = slim.nextStepStructured as { tool: string };
    expect(ns.tool).not.toBe("coverage");
    expect(ns.tool).not.toBe("checklist");
  });

  it("scan_file slim envelope ships the canonical warning code + payload schema", () => {
    const result = applyScanFileBudget({
      limit: undefined,
      offset: undefined,
      maxBytes: HARD_CEILING,
      response: buildOversizeScanFileResponse(),
    });
    expect(result.truncated).toBe(true);
    const slim = result.response as Record<string, unknown>;
    const warnings = slim.warnings as readonly string[];
    expect(warnings).toContain("response_dropped_files_oversize");
    const payload = readDropPayload(slim);
    expect(payload.preDropBytes).toBeGreaterThan(payload.hardCeilingBytes);
    expect(payload.hardCeilingBytes).toBe(HARD_CEILING);
    expect(payload.metaFieldsDropped).toContain("bloatedField");
    expect(slim.truncated).toBe(true);
  });

  it("all three slim envelopes use the same warning code identifier", () => {
    // Code identity is load-bearing for the cross-surface invariant —
    // an agent reading `warnings[]` on any of the three tools must
    // see the SAME token string. Renaming the code on one surface
    // would silently break the meta-reviewer's grep + the agent's
    // dismissal logic.
    const checklistSlim = applyChecklistBudget({
      response: buildOversizeChecklistResponse(),
      hardCeilingChars: HARD_CEILING,
    }).response as Record<string, unknown>;
    const coverageSlim = applyCoverageBudget({
      response: buildOversizeCoverageResponse(),
      hardCeilingChars: HARD_CEILING,
    }).response as Record<string, unknown>;
    const scanFileSlim = applyScanFileBudget({
      limit: undefined,
      offset: undefined,
      maxBytes: HARD_CEILING,
      response: buildOversizeScanFileResponse(),
    }).response as Record<string, unknown>;

    const checklistWarnings = checklistSlim.warnings as readonly string[];
    const coverageWarnings = coverageSlim.warnings as readonly string[];
    const scanFileWarnings = scanFileSlim.warnings as readonly string[];

    // Same code identifier across all three.
    expect(checklistWarnings).toContain("response_dropped_files_oversize");
    expect(coverageWarnings).toContain("response_dropped_files_oversize");
    expect(scanFileWarnings).toContain("response_dropped_files_oversize");

    // Same payload schema — every surface ships the same byte
    // arithmetic field set so a downstream consumer can read them
    // through one parser.
    const checklistPayload = readDropPayload(checklistSlim);
    const coveragePayload = readDropPayload(coverageSlim);
    const scanFilePayload = readDropPayload(scanFileSlim);

    expect(typeof checklistPayload.preDropBytes).toBe("number");
    expect(typeof coveragePayload.preDropBytes).toBe("number");
    expect(typeof scanFilePayload.preDropBytes).toBe("number");

    expect(typeof checklistPayload.hardCeilingBytes).toBe("number");
    expect(typeof coveragePayload.hardCeilingBytes).toBe("number");
    expect(typeof scanFilePayload.hardCeilingBytes).toBe("number");

    expect(typeof checklistPayload.totalFilesWithFindings).toBe("number");
    expect(typeof coveragePayload.totalFilesWithFindings).toBe("number");
    expect(typeof scanFilePayload.totalFilesWithFindings).toBe("number");
  });

  it("checklist + coverage slim envelopes both terminate at a scope-narrowing tool, never at each other (cycle-break invariant)", () => {
    // Cycle-break property test per
    // `docs/kb/architecture/ai-first-consumer.md` "NextStep handoffs
    // must terminate at a narrowing tool, never form a cycle between
    // transport-failing siblings."
    //
    // The canonical regression: on a bulk-vendor corpus,
    // `checklist.nextStepStructured.tool: "coverage"` while
    // `coverage.nextStepStructured.tool: "checklist"` — both surfaces
    // ship oversize on the same scope, and neither cycle exit
    // narrows scope. The agent following `nextStep` is stuck
    // alternating round trips with no narrowing path in the cycle.
    //
    // Property pinned: when both project-rooted tools' slim guards
    // fire on the same corpus, the structured `nextStep` recommendation
    // — traced one hop further on the same cwd — must reduce input
    // scope (route to `propose_config` / `scan_project` with narrowing
    // args), never echo the parameters that just produced the
    // truncation by pointing at a sibling project-rooted full-scan
    // tool.
    const checklistSlim = applyChecklistBudget({
      response: buildOversizeChecklistResponse(),
      hardCeilingChars: HARD_CEILING,
    }).response as Record<string, unknown>;
    const coverageSlim = applyCoverageBudget({
      response: buildOversizeCoverageResponse(),
      hardCeilingChars: HARD_CEILING,
    }).response as Record<string, unknown>;

    // Set of project-rooted, full-scan tools that ship from the same
    // scope-classifier as `checklist` and `coverage` — routing the
    // slim envelope at one of these on the same cwd recreates the
    // circular handoff. The slim envelopes must route to a different
    // narrowing surface (`propose_config`, `scan_project` with
    // `restrictToPaths`).
    const SIBLING_PROJECT_ROOTED_TOOLS = new Set(["checklist", "coverage"]);

    const checklistNs = checklistSlim.nextStepStructured as {
      tool: string;
      args: Record<string, unknown>;
    };
    const coverageNs = coverageSlim.nextStepStructured as {
      tool: string;
      args: Record<string, unknown>;
    };

    // Neither surface routes to a sibling project-rooted tool that
    // ships from the same scope-classifier. The cycle is broken at
    // both halves: trace `checklist.nextStep` → must NOT be `coverage`,
    // trace `coverage.nextStep` → must NOT be `checklist`.
    expect(SIBLING_PROJECT_ROOTED_TOOLS.has(checklistNs.tool)).toBe(false);
    expect(SIBLING_PROJECT_ROOTED_TOOLS.has(coverageNs.tool)).toBe(false);

    // Both terminate at the same narrowing recovery surface
    // (`propose_config`) — keeps the doctrine recovery vocabulary
    // consistent across surfaces (see also the `allFindingsVendor`
    // and `bulkVendorScopeDownNextStep` branches in
    // `src/mcp/next-step.ts`, which already route here for the
    // adjacent vendor-saturation regimes).
    expect(checklistNs.tool).toBe("propose_config");
    expect(coverageNs.tool).toBe("propose_config");
  });
});
