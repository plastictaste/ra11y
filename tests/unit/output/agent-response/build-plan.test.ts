/**
 * Unit tests for `src/output/agent-response/build-plan.ts`.
 *
 * The plan headline is the shape agents budget against, so the tests
 * here guard the honest per-`fixClass` split. The former
 * `guidanceFixesAvailable` counter summed violations from four
 * categorically different remediation lanes — mechanical-fallback,
 * real prose guidance, runtime-only, and verify-in-source — under one
 * label, which agents read as "this much `suggest_fix`-able work."
 * The replacement is a structured `fixesByClass` sibling keyed by the
 * rule-level {@link FixClass}, so each field counts one kind of thing
 * per CLAUDE.md §1 "Composite headline counts are dishonest."
 */

import { describe, expect, it } from "bun:test";
import {
  buildAgentPlan,
  countFixesByClass,
} from "../../../../src/output/agent-response/build-plan.ts";
import type { AgentFile } from "../../../../src/output/agent-response/types.ts";
import type { Violation } from "../../../../src/types/violation.ts";
import { withFindingIds } from "../../../helpers/make-violation.ts";

function makeViolations(): Violation[] {
  // One violation per `fixClass` lane, so every per-lane assertion
  // can key off an unambiguous 1 and the headline counts split
  // evenly. All four lanes are populated to exercise the full tally.
  return withFindingIds([
    {
      ruleId: "media/alt-text-missing",
      fixClass: "mechanical",
      criteria: ["wcag22:1.1.1"],
      severity: "error",
      location: { filePath: "src/a.tsx", line: 1, column: 1 },
      message: "alt text missing",
      suggestion: "add alt attribute",
    },
    {
      ruleId: "contrast/minimum",
      fixClass: "guidance",
      criteria: ["wcag22:1.4.3"],
      severity: "warning",
      location: { filePath: "src/a.tsx", line: 2, column: 1 },
      message: "contrast below threshold",
      suggestion: "choose darker color",
    },
    {
      ruleId: "focus/visible",
      fixClass: "runtime-only",
      criteria: ["wcag22:2.4.7"],
      severity: "warning",
      location: { filePath: "src/a.tsx", line: 3, column: 1 },
      message: "focus indicator depends on runtime",
      suggestion: "verify with keyboard navigation",
    },
    {
      ruleId: "keyboard/handler-missing",
      fixClass: "verify-in-source",
      criteria: ["wcag22:2.1.1"],
      severity: "error",
      location: { filePath: "src/a.tsx", line: 4, column: 1 },
      message: "interactive element has no keyboard handler",
      suggestion: "add onKeyDown matching onClick",
    },
  ]);
}

describe("buildAgentPlan: fixesByClass structured tally", () => {
  it("counts violations in the mechanical lane", () => {
    const plan = buildAgentPlan(makeViolations(), []);
    expect(plan.fixesByClass.mechanical).toBe(1);
  });

  it("counts violations in the guidance lane", () => {
    const plan = buildAgentPlan(makeViolations(), []);
    expect(plan.fixesByClass.guidance).toBe(1);
  });

  it("counts violations in the runtimeOnly lane (camelCased from `runtime-only`)", () => {
    const plan = buildAgentPlan(makeViolations(), []);
    expect(plan.fixesByClass.runtimeOnly).toBe(1);
  });

  it("counts violations in the verifyInSource lane (camelCased from `verify-in-source`)", () => {
    const plan = buildAgentPlan(makeViolations(), []);
    expect(plan.fixesByClass.verifyInSource).toBe(1);
  });

  it("emits all four lane keys with zero when the scan finds nothing", () => {
    // `fixesByClass` is always present on the plan — agents never have
    // to disambiguate "field absent" from "lane zero." Zero-count
    // lanes surface as `0` rather than being omitted, matching the
    // shape consumers read on a violating scan.
    const plan = buildAgentPlan([], []);
    expect(plan.fixesByClass).toEqual({
      mechanical: 0,
      guidance: 0,
      runtimeOnly: 0,
      verifyInSource: 0,
    });
  });
});

describe("buildAgentPlan: safeEditsAvailable counter", () => {
  it("counts only violations that ship an inline fixPaths.primary.edit", () => {
    // `safeEditsAvailable` is the "apply_fix can batch this" counter.
    // It covers both the `mechanical` and `verify-in-source` rule
    // lanes (the two lanes whose remediation lands in source). A rule
    // with `fixClass === "mechanical"` can still emit prose-only
    // findings when the AST lacks enough context — without an
    // explicit `fixPaths.primary.edit` on any test violation, the
    // counter reports 0 even though lanes are populated.
    const plan = buildAgentPlan(makeViolations(), []);
    expect(plan.safeEditsAvailable).toBe(0);
  });

  it("rises when a violation carries fixPaths.primary.edit", () => {
    const [first, ...rest] = makeViolations();
    if (first === undefined) throw new Error("fixture missing");
    const withEdit: Violation = {
      ...first,
      fixPaths: {
        primary: {
          label: "Add empty alt for decorative image",
          edit: {
            oldText: "<img>",
            newText: '<img alt="">',
          },
        },
        alternatives: [],
      },
    };
    const plan = buildAgentPlan([withEdit, ...rest], []);
    expect(plan.safeEditsAvailable).toBe(1);
  });

  it("rises for a verify-in-source violation that ships an inline edit", () => {
    // Regression guard for the rename's motivating case: the scan
    // that surfaced `plan.mechanicalEditsAvailable: 14` co-occurring
    // with `plan.fixesByClass.mechanical: 0` — every editable
    // violation routed through the `verify-in-source` lane. Under the
    // new honest name the counter captures that population; under the
    // old name the composite-under-a-singular-name mismatch this
    // fixes was invisible.
    const makeVerifyInSource = (line: number): Violation =>
      withFindingIds([
        {
          ruleId: "keyboard/handler-missing",
          fixClass: "verify-in-source",
          criteria: ["wcag22:2.1.1"],
          severity: "error",
          location: { filePath: "src/a.tsx", line, column: 1 },
          message: "handler missing",
          fixPaths: {
            primary: {
              label: "Add onKeyDown matching onClick",
              edit: { oldText: "onClick=", newText: "onKeyDown onClick=" },
            },
            alternatives: [],
          },
        },
      ])[0] as Violation;
    const plan = buildAgentPlan([makeVerifyInSource(1), makeVerifyInSource(2)], []);
    expect(plan.safeEditsAvailable).toBe(2);
    expect(plan.fixesByClass.mechanical).toBe(0);
    expect(plan.fixesByClass.verifyInSource).toBe(2);
  });
});

describe("buildAgentPlan: summary string", () => {
  it("breaks the violations parenthetical down by fixClass lane (not by suggestion presence)", () => {
    const files: AgentFile[] = [];
    const plan = buildAgentPlan(makeViolations(), files);
    // Lane order per `buildFixClassBreakdown`:
    // mechanical → guidance → runtime-only → verify-in-source.
    expect(plan.summary).toContain("4 findings");
    expect(plan.summary).toContain("1 mechanical");
    expect(plan.summary).toContain("1 guidance");
    expect(plan.summary).toContain("1 runtime-only");
    expect(plan.summary).toContain("1 verify-in-source");
    // The former "N guidance fixes" composite no longer appears —
    // that label summed runtime-only and verify-in-source under
    // "guidance" and was the exact dishonesty this change removes.
    expect(plan.summary).not.toMatch(/\d+ guidance fixes/);
  });

  it("reads 'No accessibility violations found.' when violations is 0", () => {
    const plan = buildAgentPlan([], []);
    expect(plan.summary).toBe("No accessibility violations found.");
  });
});

describe("countFixesByClass helper", () => {
  it("tallies an empty violation array as all zeros", () => {
    // Defensive: the helper must return the full four-key shape so
    // downstream consumers never have to check for missing keys.
    expect(countFixesByClass([])).toEqual({
      mechanical: 0,
      guidance: 0,
      runtimeOnly: 0,
      verifyInSource: 0,
    });
  });

  it("tallies violations across all four lanes in one pass", () => {
    const result = countFixesByClass(makeViolations());
    expect(result).toEqual({
      mechanical: 1,
      guidance: 1,
      runtimeOnly: 1,
      verifyInSource: 1,
    });
  });
});
