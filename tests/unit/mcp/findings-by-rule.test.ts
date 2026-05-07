/**
 * Unit tests for `plan.findingsByRule` — the FULL per-rule count map
 * that lets the agent paginating by rule (per-rule
 * `scan_file({ruleId})`, per-rule fix batches) budget the round-trip
 * cost without paging through `files[]`.
 *
 * Distinct slice from `topRules` (the rank-ordered top-N enriched
 * head) and `findingsByFile` (the per-path axis) — same severity
 * filter, same whole-scan framing, different aggregation shape. These
 * tests pin the behavior of `computeFindingsByRule` and
 * `withFindingsByRule` directly so the cross-surface count invariants
 * stay observable from a single file.
 */

import { describe, expect, it } from "bun:test";
import { computeFindingsByRule, withFindingsByRule } from "../../../src/mcp/findings-by-rule.ts";

const E = (ruleId: string) => ({ ruleId, severity: "error" });
const W = (ruleId: string) => ({ ruleId, severity: "warning" });
const I = (ruleId: string) => ({ ruleId, severity: "info" });

describe("computeFindingsByRule — full per-rule count map", () => {
  it("counts error+warning findings per rule across all files", () => {
    const out = computeFindingsByRule([
      {
        findings: [E("alt-text/missing"), E("alt-text/missing"), W("button/no-name")],
      },
      { findings: [E("alt-text/missing"), W("contrast/minimum")] },
    ]);
    expect(out).toEqual({
      "alt-text/missing": 3,
      "button/no-name": 1,
      "contrast/minimum": 1,
    });
  });

  it("excludes info-severity findings — same filter as topRules / findingsByFile", () => {
    const out = computeFindingsByRule([
      {
        findings: [
          E("alt-text/missing"),
          I("wrappers/inferred"),
          I("wrappers/inferred"),
          W("button/no-name"),
        ],
      },
    ]);
    // `wrappers/inferred` was emitted twice but at info severity — both
    // are filtered from the rollup so the per-rule counts agree with
    // the error+warning surface `plan.fixesByClass` tallies.
    expect(out).toEqual({
      "alt-text/missing": 1,
      "button/no-name": 1,
    });
  });

  it("returns an empty object on a clean scan (no findings)", () => {
    expect(computeFindingsByRule([])).toEqual({});
    expect(computeFindingsByRule([{ findings: [] }, { findings: [] }])).toEqual({});
  });

  it("returns an empty object when the only findings are info-severity", () => {
    // `wrappers/inferred` etc. without any error/warning is a clean
    // scan from the headline tally's perspective. The conditional
    // spread on `withFindingsByRule` relies on this identity.
    expect(computeFindingsByRule([{ findings: [I("wrappers/inferred"), I("note/x")] }])).toEqual(
      {},
    );
  });

  it("preserves the long-tail axis topRules clips — every rule with at least one error/warning is present", () => {
    // Build 15 distinct rules, each with one error finding. `topRules`
    // would clip to its 10-entry default; `findingsByRule` carries
    // every entry so the agent paginating by rule can budget the long
    // tail. The headline-doctrine "Sibling fields naming the same
    // concept must use one shape" check: the slice difference is what
    // justifies the second shape.
    const findings = [];
    for (let i = 0; i < 15; i += 1) findings.push(E(`rule-${i}`));
    const out = computeFindingsByRule([{ findings }]);
    expect(Object.keys(out)).toHaveLength(15);
    for (let i = 0; i < 15; i += 1) {
      expect(out[`rule-${i}`]).toBe(1);
    }
  });
});

describe("withFindingsByRule — conditional spread on the plan", () => {
  it("identity-stable when no error/warning findings emerged (returns the input plan unchanged)", () => {
    const plan = { fixesByClass: {}, summary: "No accessibility violations found." };
    const out = withFindingsByRule(plan, []);
    expect(out).toBe(plan); // identity, not just structural equality
  });

  it("identity-stable when only info-severity findings emerged", () => {
    const plan = { fixesByClass: {}, summary: "Some notes only." };
    const out = withFindingsByRule(plan, [{ findings: [I("wrappers/inferred")] }]);
    expect(out).toBe(plan);
  });

  it("stamps `findingsByRule` onto the plan as a flat ruleId→count map", () => {
    const plan = { fixesByClass: {}, summary: "..." };
    const out = withFindingsByRule(plan, [
      { findings: [E("alt-text/missing"), E("alt-text/missing"), W("contrast/minimum")] },
    ]);
    expect(out).toMatchObject({
      fixesByClass: {},
      summary: "...",
      findingsByRule: { "alt-text/missing": 2, "contrast/minimum": 1 },
    });
  });

  it("preserves all input plan keys verbatim alongside the new field", () => {
    const plan = {
      infoSeverityFindings: 0,
      fixesByClass: { mechanical: { source: 1, buildArtifact: 0 } },
      reviewNeeded: 0,
      manualOnly: 0,
      estimatedEffort: "trivial",
      summary: "1 mechanical.",
      topRules: [{ ruleId: "alt-text/missing", count: 1 }],
      findingsByFile: [{ path: "a.html", count: 1 }],
    };
    const out = withFindingsByRule(plan, [{ findings: [E("alt-text/missing")] }]);
    // All original keys present + the new one — `findingsByRule` is
    // additive and never replaces a sibling.
    expect(Object.keys(out).sort()).toEqual(
      [
        "infoSeverityFindings",
        "fixesByClass",
        "reviewNeeded",
        "manualOnly",
        "estimatedEffort",
        "summary",
        "topRules",
        "findingsByFile",
        "findingsByRule",
      ].sort(),
    );
  });
});
