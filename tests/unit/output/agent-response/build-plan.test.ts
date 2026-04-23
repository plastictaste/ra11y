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

describe("buildAgentPlan: dropped safeEditsAvailable composite", () => {
  // Q-SHARED-SAFE-EDITS-VS-MECHANICAL-DISAGREEMENT: the former
  // `plan.safeEditsAvailable` counted violations whose
  // `fixPaths.primary.edit` was populated across the mechanical +
  // verify-in-source lanes. It sat as a sibling to
  // `plan.fixesByClass.mechanical` under names both framed as "how
  // many fixes an agent can apply" — the two disagreed by up to 18×
  // on real field-report responses because they measured different
  // slices. Per CLAUDE.md §1 "Composite headline counts are dishonest,"
  // the composite was dropped; the per-lane `fixesByClass` carries
  // the honest signal and agents sum
  // `fixesByClass.mechanical + fixesByClass.verifyInSource` when they
  // want the apply-now subset.

  it("does NOT surface a safeEditsAvailable field on the plan", () => {
    const plan = buildAgentPlan(makeViolations(), []);
    expect((plan as unknown as Record<string, unknown>)["safeEditsAvailable"]).toBeUndefined();
  });

  it("does NOT surface safeEditsAvailable even when a violation ships fixPaths.primary.edit", () => {
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
    expect((plan as unknown as Record<string, unknown>)["safeEditsAvailable"]).toBeUndefined();
    // The per-lane `fixesByClass.mechanical` key still reflects the
    // rule-level lane of the edited violation — that's the honest
    // signal callers read instead of a composite.
    expect(plan.fixesByClass.mechanical).toBe(1);
  });

  it("lets callers derive the apply-now subset from fixesByClass on verify-in-source edits", () => {
    // Regression guard for the motivating field-report case: a scan
    // with `plan.safeEditsAvailable: 14` co-occurring with
    // `plan.fixesByClass.mechanical: 0` — every editable violation
    // routed through the `verify-in-source` lane. Under the dropped
    // composite the two numbers disagreed and confused the caller;
    // under the honest per-lane shape the caller sums
    // `fixesByClass.mechanical + fixesByClass.verifyInSource`
    // (= 2 here) without a second overlapping field on the wire.
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
    expect((plan as unknown as Record<string, unknown>)["safeEditsAvailable"]).toBeUndefined();
    expect(plan.fixesByClass.mechanical).toBe(0);
    expect(plan.fixesByClass.verifyInSource).toBe(2);
    // The apply-now subset the former composite tried to express is
    // now a trivial sum of two honest per-lane keys.
    expect(plan.fixesByClass.mechanical + plan.fixesByClass.verifyInSource).toBe(2);
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
