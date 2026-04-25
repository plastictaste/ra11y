/**
 * Unit tests for buildPlanSummary — the human-readable `plan.summary`
 * string on `scan_project` responses.
 *
 * Load-bearing invariant (Q7-PLAN-VIOLATIONS-COMPOSITE): the lane
 * breakdown emits as a flat fragment (`"266 mechanical, 616 guidance,
 * …"`) with no leading "N findings" composite headline. A composite
 * total summed across categorically different lanes (mechanical
 * edits + verify-in-source prose + guidance rewrites + runtime-only)
 * is the same shape as the deleted `plan.totalFindings` and
 * `plan.safeEditsAvailable` precedents — agents budget against the
 * composite as if every entry were an actionable edit when in
 * reality two of the four lanes are prose-only. Per
 * `docs/kb/architecture/ai-first-consumer.md` "Composite headline
 * counts are dishonest," the per-lane breakdown is the honest
 * signal. Callers that want the flat count sum the four lanes
 * themselves.
 *
 * This invariant supersedes the earlier Q-SHARED-PLAN-SUMMARY-VERIFY-IN-SOURCE-INFLATION
 * fix (which renamed "violations" to "findings"): the noun was a
 * partial fix, the deletion is the durable one.
 */

import { describe, expect, it } from "bun:test";
import { buildPlanSummary } from "../../../src/mcp/plan-summary.ts";

const EMPTY_LANES = {
  mechanical: 0,
  guidance: 0,
  "runtime-only": 0,
  "verify-in-source": 0,
} as const;

describe("buildPlanSummary", () => {
  it("emits the per-lane breakdown without a composite 'N findings' headline", () => {
    // Shape reproducing the Bootstrap repro: most of the total is
    // `verify-in-source` (prose-only guidance). Per
    // Q7-PLAN-VIOLATIONS-COMPOSITE the flat headline is gone; the
    // honest signal is the per-lane fragment.
    const summary = buildPlanSummary({
      violations: 2273,
      notes: 0,
      fixClassCounts: {
        mechanical: 266,
        guidance: 616,
        "runtime-only": 57,
        "verify-in-source": 1334,
      },
      actionableManual: 0,
      untargetedCriteria: 0,
    });
    // Lane breakdown lands as a flat fragment.
    expect(summary).toContain("266 mechanical");
    expect(summary).toContain("616 guidance");
    expect(summary).toContain("57 runtime-only");
    expect(summary).toContain("1334 verify-in-source");
    // The flat composite total — under any noun — is gone. The
    // exact 2273 is the sum of the four lanes; it must NOT appear
    // as a standalone headline followed by "findings" or
    // "violations" (the precedents the deletion supersedes).
    expect(summary).not.toMatch(/\b2273\s+(findings?|violations?)\b/);
  });

  it("emits a single-lane fragment when only one lane has violations", () => {
    const summary = buildPlanSummary({
      violations: 1,
      notes: 0,
      fixClassCounts: { ...EMPTY_LANES, mechanical: 1 },
      actionableManual: 0,
      untargetedCriteria: 0,
    });
    expect(summary).toContain("1 mechanical");
    // No leading composite headline.
    expect(summary).not.toMatch(/\b1\s+(findings?|violations?)\b/);
  });

  it("emits the per-lane fragment when every violation lands in one lane", () => {
    const summary = buildPlanSummary({
      violations: 4,
      notes: 0,
      fixClassCounts: { ...EMPTY_LANES, mechanical: 4 },
      actionableManual: 0,
      untargetedCriteria: 0,
    });
    expect(summary).toContain("4 mechanical");
    expect(summary).not.toMatch(/\b4\s+(findings?|violations?)\b/);
  });

  it("emits 'No automated findings' when both violations and notes are zero", () => {
    const summary = buildPlanSummary({
      violations: 0,
      notes: 0,
      fixClassCounts: EMPTY_LANES,
      actionableManual: 0,
      untargetedCriteria: 0,
    });
    expect(summary).toBe("No automated findings.");
  });

  it("keeps notes and manual-review fragments intact alongside the lane breakdown", () => {
    const summary = buildPlanSummary({
      violations: 3,
      notes: 2,
      fixClassCounts: { ...EMPTY_LANES, mechanical: 2, "verify-in-source": 1 },
      actionableManual: 5,
      untargetedCriteria: 7,
    });
    expect(summary).toContain("2 mechanical");
    expect(summary).toContain("1 verify-in-source");
    expect(summary).toContain("2 notes to review");
    expect(summary).toContain("5 actionable manual review items");
    expect(summary).toContain("+ 7 untargeted criteria");
    // No composite headline summing the lanes.
    expect(summary).not.toMatch(/\b3\s+(findings?|violations?)\b/);
  });
});
