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
    items: [{ criterionId: "wcag22:1.1.1", candidates: [{ path: "x.tsx", line: 1 }] }],
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
    actionableManualItems: 1,
    untargetedCriteria: 0,
    summary: "1/1 evaluated",
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
    // nextStep cross-routes — never re-issues `checklist`.
    const ns = slim.nextStepStructured as { tool: string };
    expect(ns.tool).not.toBe("checklist");
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
    // nextStep cross-routes — never re-issues `coverage`.
    const ns = slim.nextStepStructured as { tool: string };
    expect(ns.tool).not.toBe("coverage");
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
});
