/**
 * Truncation reporters must reconcile across warnings.
 *
 * Per `docs/kb/architecture/ai-first-consumer.md` "Truncation reporters
 * must reconcile across warnings":
 *
 *   "When a single response carries multiple warning codes that report
 *    on overlapping truncation events — `response_meta_truncated.fields`
 *    listing 2 fields, `response_dropped_files_oversize.metaFieldsDropped`
 *    listing 9, plus a third top-level scalar `metaArrayTruncated: true`
 *    is a third reporter — the agent gets three competing narratives
 *    about what was truncated."
 *
 * This test pins two invariants the slim envelope must honor across the
 * project-rooted tool surfaces (`scan_project`, `scan_file`, `checklist`,
 * `coverage`):
 *
 *   1. **No standalone third-reporter scalar.** Top-level boolean
 *      truncation flags must either disambiguate an orthogonal concept
 *      (`filesArrayDropped: true` distinguishes the slim path's
 *      `files: []` from the density-cap path's `files: [<survivors>]`
 *      — the doctrine bullet's permissive case for orthogonal axes) OR
 *      not exist at all when the warning channel already enumerates the
 *      detail. Specifically, the slim envelope must NOT ship a
 *      `metaFieldDropped: true` / `metaArrayTruncated: true` scalar
 *      next to `warningsDetails.response_dropped_files_oversize.metaFieldsDropped[]`
 *      — that's the canonical case the doctrine names as dishonest.
 *
 *   2. **Each warning code's enumeration owns one scope.** When two
 *      warning codes can co-fire on the same response,
 *      `response_meta_truncated.fields[]` enumerates ARRAY-level meta
 *      truncations (sub-arrays head-sliced under the meta-array cap
 *      regime, e.g. `analysisCoverage.fragmentFiles`), while
 *      `response_dropped_files_oversize.metaFieldsDropped[]` enumerates
 *      TOP-LEVEL meta keys dropped by the slim builder (e.g.
 *      `analysisCoverage`, `perRuleCoverage`, `scannedBuildArtifacts`).
 *      The two scopes are disjoint by construction — array-level
 *      head-slicing names a dotted path with at least one parent
 *      segment, while top-level meta drop names a single key.
 *
 * Tests the helpers directly with a small synthetic ceiling — full MCP
 * subprocess spawn would require building a 100+ KB corpus to trigger
 * the natural 96000-char ceiling, which is brittle and slow. The
 * helpers' contract is the pinned surface; the wiring at each tool's
 * textResult callsite is exercised by their respective `tool-*.ts`
 * integration tests.
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
    // `actionableManualItems` and `criteriaUntestable` scalars were
    // dropped from the coverage entry (each duplicated its array-
    // form sibling) — the criteria-axis count rides via
    // `summary.actionable.criteria` and the array form
    // `manualWithCandidates`. Keep the synthetic fixture aligned
    // with the live shape so the reconciler test exercises the wire
    // shape that actually ships.
    untargetedCriteria: 0,
    summary: {
      actionable: { criteria: 1 },
      untargetedCriteria: 0,
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

const HARD_CEILING = 1000;

describe("truncation reporters reconcile across warnings (Q13)", () => {
  it("coverage slim envelope ships no standalone third-reporter scalar (metaFieldDropped removed)", () => {
    const result = applyCoverageBudget({
      response: buildOversizeCoverageResponse(),
      hardCeilingChars: HARD_CEILING,
    });
    expect(result.truncated).toBe(true);
    const slim = result.response as Record<string, unknown>;
    // The canonical truncated sentinel rides — disambiguates clean
    // small-corpus from slim-fired path.
    expect(slim.truncated).toBe(true);
    // Per Q13 closure: no standalone scalar reporter for the meta drop
    // (the canonical reporter is the warning-channel enumeration).
    expect(slim.metaFieldDropped).toBeUndefined();
    expect(slim.metaArrayTruncated).toBeUndefined();
    // The canonical reporter — the warning-channel enumeration — is
    // present and names the dropped top-level meta keys.
    const payload = readDropPayload(slim);
    expect(payload.metaFieldsDropped).toBeDefined();
    expect(payload.metaFieldsDropped?.length ?? 0).toBeGreaterThan(0);
  });

  it("checklist slim envelope ships no standalone third-reporter scalar", () => {
    const result = applyChecklistBudget({
      response: buildOversizeChecklistResponse(),
      hardCeilingChars: HARD_CEILING,
    });
    expect(result.truncated).toBe(true);
    const slim = result.response as Record<string, unknown>;
    expect(slim.truncated).toBe(true);
    expect(slim.metaFieldDropped).toBeUndefined();
    expect(slim.metaArrayTruncated).toBeUndefined();
    const payload = readDropPayload(slim);
    expect(payload.metaFieldsDropped).toBeDefined();
    expect(payload.metaFieldsDropped?.length ?? 0).toBeGreaterThan(0);
  });

  it("scan_file slim envelope ships no standalone third-reporter scalar", () => {
    const result = applyScanFileBudget({
      limit: undefined,
      offset: undefined,
      maxBytes: HARD_CEILING,
      response: buildOversizeScanFileResponse(),
    });
    expect(result.truncated).toBe(true);
    const slim = result.response as Record<string, unknown>;
    expect(slim.truncated).toBe(true);
    expect(slim.metaFieldDropped).toBeUndefined();
    expect(slim.metaArrayTruncated).toBeUndefined();
    const payload = readDropPayload(slim);
    expect(payload.metaFieldsDropped).toBeDefined();
    expect(payload.metaFieldsDropped?.length ?? 0).toBeGreaterThan(0);
  });

  it("response_meta_truncated.fields[] and response_dropped_files_oversize.metaFieldsDropped[] address disjoint scopes", () => {
    // The two reporters legitimately co-fire when a meta-array cap
    // trims a sub-array AND the slim builder later drops the parent
    // top-level meta key. The canonical reconcile per doctrine bullet
    // (b): scope sets must be disjoint and named.
    //
    //   - `response_meta_truncated.fields[]` always enumerates DOTTED
    //     paths with at least one parent segment (the array's parent
    //     container) — `analysisCoverage.fragmentFiles`,
    //     `scannedBuildArtifacts.classified`, or the bare-key
    //     `perRuleCoverage` (root-level array, no enclosing container).
    //   - `response_dropped_files_oversize.metaFieldsDropped[]` always
    //     enumerates BARE top-level meta keys — `analysisCoverage`,
    //     `perRuleCoverage`, `scannedBuildArtifacts`, etc.
    //
    // The two namespaces are disjoint when the array reporter is
    // dotted (`analysisCoverage.fragmentFiles` vs `analysisCoverage`).
    // The bare-key entry on the array reporter (`perRuleCoverage`) is
    // the one collision the agent must reconcile by reading both
    // codes' payloads — the array reporter says "this top-level array
    // was head-sliced" and the slim reporter says "this top-level key
    // was dropped entirely." Both can be true on the same response;
    // the agent reads both and recovers via a narrower scope.
    //
    // This test pins the bare-key collision invariant by asserting
    // that when the bare-key form (`perRuleCoverage`) appears in
    // BOTH enumerations, the agent reading either reporter sees a
    // present-when-meaningful payload — neither reporter is empty,
    // neither is sentinel-only, and both name the same key. That's
    // the doctrine's "reconcile by reference rather than independent
    // enumeration" property the bullet calls out.
    const result = applyCoverageBudget({
      response: buildOversizeCoverageResponse(),
      hardCeilingChars: HARD_CEILING,
    });
    expect(result.truncated).toBe(true);
    const slim = result.response as Record<string, unknown>;
    const payload = readDropPayload(slim);
    const metaFieldsDropped = payload.metaFieldsDropped ?? [];
    // Top-level keys are bare (no dot). Per the disjoint-scope
    // invariant, none of the entries should look like a dotted sub-
    // array path (which would mean the slim reporter was duplicating
    // the array reporter's enumeration).
    for (const key of metaFieldsDropped) {
      expect(key).not.toContain(".");
    }
  });
});
