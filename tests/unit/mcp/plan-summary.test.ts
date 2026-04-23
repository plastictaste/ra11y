/**
 * Unit tests for buildPlanSummary — the human-readable `plan.summary`
 * string on `scan_project` responses.
 *
 * Load-bearing invariant: the lane-breakdown parenthetical is headed
 * by "N finding(s)", not "N violation(s)". The breakdown mixes
 * directly-actionable (`mechanical`) with prose-only
 * (`guidance` / `verify-in-source` / `runtime-only`) lanes — labeling
 * the composite as "violations" promises one kind of work and
 * delivers four. "Findings" is the honest umbrella noun and matches
 * the CLI agent surface (`src/output/agent-response/build-plan.ts`),
 * so both summary formatters emit aligned phrasing.
 *
 * This invariant closes Q-SHARED-PLAN-SUMMARY-VERIFY-IN-SOURCE-INFLATION:
 * a real-world Bootstrap scan returned
 * `"2273 violations (266 mechanical, 616 guidance, 57 runtime-only, 1334 verify-in-source)"`
 * where 59% of the "violations" total was `verify-in-source`
 * (prose-only guidance). The new shape drops the "violations" noun
 * from the lane-breakdown headline.
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
  it("uses 'findings' (not 'violations') as the lane-breakdown headline noun", () => {
    // Shape reproducing the Bootstrap repro in Q-SHARED-PLAN-SUMMARY-VERIFY-IN-SOURCE-INFLATION:
    // most of the total is `verify-in-source` (prose-only guidance).
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
    // Headline noun: "findings", never "violations", when a lane
    // breakdown is present. The old shape read `"2273 violations (...)"`
    // which sums prose-only lanes under an actionable-sounding label.
    expect(summary).toContain("2273 findings");
    expect(summary).not.toMatch(/\d+ violations?\b/);
    // Lane breakdown still lands verbatim.
    expect(summary).toContain("266 mechanical");
    expect(summary).toContain("616 guidance");
    expect(summary).toContain("57 runtime-only");
    expect(summary).toContain("1334 verify-in-source");
  });

  it("uses singular 'finding' when violations === 1", () => {
    const summary = buildPlanSummary({
      violations: 1,
      notes: 0,
      fixClassCounts: { ...EMPTY_LANES, mechanical: 1 },
      actionableManual: 0,
      untargetedCriteria: 0,
    });
    expect(summary).toContain("1 finding (1 mechanical)");
    expect(summary).not.toMatch(/\d+ violations?\b/);
  });

  it("uses plural 'findings' when violations > 1 with only mechanical lane", () => {
    // Verifies the rename is unconditional — even when the breakdown
    // is 100% mechanical (i.e. fully actionable), the noun stays
    // "findings" so both summary surfaces (CLI agent + MCP) emit one
    // shape. Mixed-noun conditional would force consumers to parse
    // either word, which the doctrine names as dishonest.
    const summary = buildPlanSummary({
      violations: 4,
      notes: 0,
      fixClassCounts: { ...EMPTY_LANES, mechanical: 4 },
      actionableManual: 0,
      untargetedCriteria: 0,
    });
    expect(summary).toContain("4 findings (4 mechanical)");
    expect(summary).not.toMatch(/\d+ violations?\b/);
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

  it("keeps notes and manual-review fragments intact alongside the finding count", () => {
    const summary = buildPlanSummary({
      violations: 3,
      notes: 2,
      fixClassCounts: { ...EMPTY_LANES, mechanical: 2, "verify-in-source": 1 },
      actionableManual: 5,
      untargetedCriteria: 7,
    });
    expect(summary).toContain("3 findings (2 mechanical, 1 verify-in-source)");
    expect(summary).toContain("2 notes to review");
    expect(summary).toContain("5 actionable manual review items");
    expect(summary).toContain("+ 7 untargeted criteria");
  });
});
