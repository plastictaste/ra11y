/**
 * Unit tests for buildRuleCoverageDerivative — the top-level
 * `ruleCoverage.{confidentlyClean, lowConfidenceClean}` split on scan
 * responses.
 *
 * Shape invariants under test:
 *   - Split is honest: high-confidence 0-findings rules land in
 *     `confidentlyClean`; low-confidence 0-findings rules land in
 *     `lowConfidenceClean`.
 *   - A rule that produced violations is absent from both buckets
 *     (it's "already flagged"; the derivative is about the clean tail).
 *   - Empty-on-both-sides returns null so the caller can omit the
 *     field entirely — the CLAUDE.md §1 "Ambiguous field shapes are
 *     dishonest" contract.
 */

import { describe, expect, it } from "bun:test";
import { buildRuleCoverageDerivative } from "../../../src/mcp/rule-coverage-derivative.ts";
import type { PerRuleCoverage, Violation } from "../../../src/types/violation.ts";

function highRow(ruleId: string, eligible = 3): PerRuleCoverage {
  return {
    ruleId,
    filesEvaluated: eligible,
    filesEligible: eligible,
    findingsEmitted: 0,
    coverageConfidence: "high",
  };
}

function lowRow(ruleId: string): PerRuleCoverage {
  return {
    ruleId,
    filesEvaluated: 0,
    filesEligible: 0,
    findingsEmitted: 0,
    coverageConfidence: "low",
    reason: "no files matching .css were scanned",
    remediation: "add CSS sources to the scan path",
  };
}

/**
 * "medium" coverage — introduced by ADR 0026 for rules whose evidence
 * horizon was bounded on this substrate (canonical:
 * `keyboard/handler-missing` on a single HTML file when the click
 * handler may live in an external `.js` sibling). Reserved until the
 * downstream audit (Q5-COVERAGE-CONFIDENCE-HONESTY-CROSS-FILE-BLINDSPOT)
 * wires the downgrade; this helper lets the derivative test pin the
 * transient-conflation behaviour against the widened union.
 */
function mediumRow(ruleId: string): PerRuleCoverage {
  return {
    ruleId,
    filesEvaluated: 1,
    filesEligible: 1,
    findingsEmitted: 0,
    coverageConfidence: "medium",
    reason: "cross_file_listener_resolution_limited_on_this_input",
  };
}

function mkViolation(ruleId: string): Violation {
  return {
    ruleId,
    fixClass: "guidance",
    criteria: ["wcag22:1.4.3"],
    severity: "warning",
    location: { filePath: "a.tsx", line: 1, column: 1 },
    message: "test",
    findingId: "test",
    groupKey: "test",
  };
}

describe("buildRuleCoverageDerivative", () => {
  it("splits 0-findings rules by coverageConfidence", () => {
    const per: PerRuleCoverage[] = [
      highRow("media/alt-text-missing"),
      highRow("forms/labels-required"),
      lowRow("contrast/minimum"),
      lowRow("layout/text-spacing"),
    ];
    const result = buildRuleCoverageDerivative(per, []);
    expect(result).not.toBeNull();
    expect(result!.confidentlyClean).toEqual(["forms/labels-required", "media/alt-text-missing"]);
    expect(result!.lowConfidenceClean).toEqual(["contrast/minimum", "layout/text-spacing"]);
  });

  it("excludes rules that produced violations from both buckets", () => {
    const per: PerRuleCoverage[] = [highRow("media/alt-text-missing"), lowRow("contrast/minimum")];
    const violations = [mkViolation("media/alt-text-missing")];
    const result = buildRuleCoverageDerivative(per, violations);
    expect(result!.confidentlyClean).not.toContain("media/alt-text-missing");
    expect(result!.lowConfidenceClean).toEqual(["contrast/minimum"]);
  });

  it("returns null when every row produced findings (no clean tail to split)", () => {
    const per: PerRuleCoverage[] = [highRow("media/alt-text-missing")];
    const violations = [mkViolation("media/alt-text-missing")];
    const result = buildRuleCoverageDerivative(per, violations);
    expect(result).toBeNull();
  });

  it("returns null when the coverage array is empty", () => {
    const result = buildRuleCoverageDerivative([], []);
    expect(result).toBeNull();
  });

  it("surfaces low-confidence-clean even when confidentlyClean is empty", () => {
    const per: PerRuleCoverage[] = [lowRow("contrast/minimum")];
    const result = buildRuleCoverageDerivative(per, []);
    expect(result).not.toBeNull();
    expect(result!.confidentlyClean).toEqual([]);
    expect(result!.lowConfidenceClean).toEqual(["contrast/minimum"]);
  });

  // ADR 0026: "medium" confidence rows route into `lowConfidenceClean`
  // under the transient-conflation contract documented on the
  // derivative module. The follow-up audit may split them out; until
  // then, the agent triage shape "do not trust the clean tally without
  // verifying" is the same for "medium" and "low," so the collapse is
  // safe (an agent acting on `lowConfidenceClean` re-reads the
  // per-row `coverageConfidence` + `reason` to learn which kind it is
  // looking at). The per-row value stays honest — it does NOT get
  // rewritten to "low" by the derivative.
  it("routes 'medium' coverage rows into lowConfidenceClean (ADR 0026 transient conflation)", () => {
    const per: PerRuleCoverage[] = [
      highRow("media/alt-text-missing"),
      mediumRow("keyboard/handler-missing"),
      lowRow("contrast/minimum"),
    ];
    const result = buildRuleCoverageDerivative(per, []);
    expect(result).not.toBeNull();
    expect(result!.confidentlyClean).toEqual(["media/alt-text-missing"]);
    // `"medium"` and `"low"` both land here — the derivative's two-
    // bucket shape is unchanged. Sorted alphabetically for
    // cross-run stability (same invariant the high bucket honors).
    expect(result!.lowConfidenceClean).toEqual([
      "contrast/minimum",
      "keyboard/handler-missing",
    ]);
    // Per-row honesty: the derivative does not mutate the input rows.
    const medium = per.find((r) => r.ruleId === "keyboard/handler-missing");
    expect(medium?.coverageConfidence).toBe("medium");
  });
});
