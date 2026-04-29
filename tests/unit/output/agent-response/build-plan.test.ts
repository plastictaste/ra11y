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
  it("counts violations in the mechanical lane (source axis on a no-vendor scan)", () => {
    const plan = buildAgentPlan(makeViolations(), []);
    // Each lane carries a per-scan-kind sub-tally (`source` +
    // `buildArtifact`). The CLI agent format scope doesn't run the
    // build-artifact classifier, so every finding routes to `source`
    // — `buildArtifact` is honestly zero, not absent.
    expect(plan.fixesByClass.mechanical).toEqual({ source: 1, buildArtifact: 0 });
  });

  it("counts violations in the guidance lane", () => {
    const plan = buildAgentPlan(makeViolations(), []);
    expect(plan.fixesByClass.guidance).toEqual({ source: 1, buildArtifact: 0 });
  });

  it("counts violations in the runtimeOnly lane (camelCased from `runtime-only`)", () => {
    const plan = buildAgentPlan(makeViolations(), []);
    expect(plan.fixesByClass.runtimeOnly).toEqual({ source: 1, buildArtifact: 0 });
  });

  it("counts violations in the verifyInSource lane (camelCased from `verify-in-source`)", () => {
    const plan = buildAgentPlan(makeViolations(), []);
    expect(plan.fixesByClass.verifyInSource).toEqual({ source: 1, buildArtifact: 0 });
  });

  it("emits all four lane keys with zero pairs when the scan finds nothing", () => {
    // `fixesByClass` is always present on the plan — agents never have
    // to disambiguate "field absent" from "lane zero." Each lane's
    // per-scan-kind pair surfaces as `{ source: 0, buildArtifact: 0 }`
    // rather than being omitted, matching the shape consumers read on
    // a violating scan.
    const plan = buildAgentPlan([], []);
    expect(plan.fixesByClass).toEqual({
      mechanical: { source: 0, buildArtifact: 0 },
      guidance: { source: 0, buildArtifact: 0 },
      runtimeOnly: { source: 0, buildArtifact: 0 },
      verifyInSource: { source: 0, buildArtifact: 0 },
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
    // signal callers read instead of a composite. The lane carries a
    // per-scan-kind sub-tally; on the CLI agent path with no vendor
    // classification, the count rides in the `source` half.
    expect(plan.fixesByClass.mechanical).toEqual({ source: 1, buildArtifact: 0 });
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
    expect(plan.fixesByClass.mechanical).toEqual({ source: 0, buildArtifact: 0 });
    expect(plan.fixesByClass.verifyInSource).toEqual({ source: 2, buildArtifact: 0 });
    // The apply-now subset the former composite tried to express is
    // now a trivial sum of two honest per-lane sub-tallies.
    const mechanicalTotal =
      plan.fixesByClass.mechanical.source + plan.fixesByClass.mechanical.buildArtifact;
    const verifyInSourceTotal =
      plan.fixesByClass.verifyInSource.source + plan.fixesByClass.verifyInSource.buildArtifact;
    expect(mechanicalTotal + verifyInSourceTotal).toBe(2);
  });
});

describe("buildAgentPlan: dropped violations composite", () => {
  // The former `plan.violations` summed across the four `fixesByClass`
  // lanes (mechanical + verify-in-source + guidance + runtimeOnly)
  // under one top-level integer. Agents budgeted against it as if
  // every entry were an actionable edit when in reality two of the
  // four lanes are prose-only. Same shape as the deleted
  // `plan.totalFindings` (severity-distinct lanes) and
  // `plan.safeEditsAvailable` (two editable lanes) precedents — per
  // `docs/kb/architecture/ai-first-consumer.md` "Composite headline
  // counts are dishonest," the structured `fixesByClass` is the
  // honest tally and the composite was deleted (not renamed) so the
  // silent-miss failure mode of two disagreeing siblings can't
  // reopen.

  it("does NOT surface a `violations` field on the plan", () => {
    const plan = buildAgentPlan(makeViolations(), []);
    expect((plan as unknown as Record<string, unknown>)["violations"]).toBeUndefined();
  });

  it("does NOT surface a `violations` field even when no violations exist (clean scan)", () => {
    const plan = buildAgentPlan([], []);
    expect((plan as unknown as Record<string, unknown>)["violations"]).toBeUndefined();
  });

  it("does NOT surface a renamed `violationsComposite` field (deletion is durable, not relabeled)", () => {
    // Per the precedent established for `plan.totalFindings` (deleted
    // 2026-04-24, NOT renamed to `totalFindingsComposite`): a renamed-
    // but-retained sibling still occupies the "first thing the agent
    // reads" slot — the silent-miss failure mode is identical to the
    // original. This guard ensures we don't reintroduce the same
    // shape under a new name.
    const plan = buildAgentPlan(makeViolations(), []);
    const record = plan as unknown as Record<string, unknown>;
    expect(record["violationsComposite"]).toBeUndefined();
    expect(record["totalViolations"]).toBeUndefined();
  });

  it("the structured per-lane `fixesByClass` carries the honest tally callers sum themselves", () => {
    // The signal a former `plan.violations` consumer wanted is now a
    // trivial sum of the four per-lane keys, each of which names
    // exactly what it measures. Each lane carries a per-scan-kind
    // sub-tally; the flat per-lane number is the sum of `source +
    // buildArtifact`.
    const plan = buildAgentPlan(makeViolations(), []);
    const laneSum = (lane: { readonly source: number; readonly buildArtifact: number }): number =>
      lane.source + lane.buildArtifact;
    const flatTotal =
      laneSum(plan.fixesByClass.mechanical) +
      laneSum(plan.fixesByClass.guidance) +
      laneSum(plan.fixesByClass.runtimeOnly) +
      laneSum(plan.fixesByClass.verifyInSource);
    // makeViolations() seeds one violation per lane.
    expect(flatTotal).toBe(4);
  });
});

describe("buildAgentPlan: summary string", () => {
  it("emits the per-lane breakdown without a composite 'N findings' headline", () => {
    const files: AgentFile[] = [];
    const plan = buildAgentPlan(makeViolations(), files);
    // Per the prose drops the leading
    // composite total that summed across the four lanes. The lane
    // fragments still ride in the same stable order:
    // mechanical → guidance → runtime-only → verify-in-source.
    expect(plan.summary).toContain("1 mechanical");
    expect(plan.summary).toContain("1 guidance");
    expect(plan.summary).toContain("1 runtime-only");
    expect(plan.summary).toContain("1 verify-in-source");
    // The former "N findings (...)" composite no longer appears —
    // see for rationale (same shape as
    // the deleted `plan.totalFindings` and `plan.safeEditsAvailable`
    // precedents).
    expect(plan.summary).not.toMatch(/\b4\s+(findings?|violations?)\b/);
    // The earlier "N guidance fixes" composite is also gone.
    expect(plan.summary).not.toMatch(/\d+ guidance fixes/);
  });

  it("reads 'No accessibility violations found.' when violations is 0", () => {
    const plan = buildAgentPlan([], []);
    expect(plan.summary).toBe("No accessibility violations found.");
  });
});

describe("countFixesByClass helper", () => {
  it("tallies an empty violation array as all zero pairs", () => {
    // Defensive: the helper must return the full four-key shape so
    // downstream consumers never have to check for missing keys.
    expect(countFixesByClass([])).toEqual({
      mechanical: { source: 0, buildArtifact: 0 },
      guidance: { source: 0, buildArtifact: 0 },
      runtimeOnly: { source: 0, buildArtifact: 0 },
      verifyInSource: { source: 0, buildArtifact: 0 },
    });
  });

  it("tallies violations across all four lanes in one pass (no vendor paths)", () => {
    const result = countFixesByClass(makeViolations());
    expect(result).toEqual({
      mechanical: { source: 1, buildArtifact: 0 },
      guidance: { source: 1, buildArtifact: 0 },
      runtimeOnly: { source: 1, buildArtifact: 0 },
      verifyInSource: { source: 1, buildArtifact: 0 },
    });
  });

  it("routes findings on vendor paths into the buildArtifact half of each lane", () => {
    // When the build-artifact classifier produces a non-empty path
    // set, `countFixesByClass` splits each lane per scan-kind so the
    // cross-surface invariant `sum(fixesByClass[*].X) ===
    // violationsByScanKind[X]` holds. The fixture seeds one violation
    // per lane on a vendor path, so every `source` count drops to
    // zero and every `buildArtifact` count rises to one.
    const result = countFixesByClass(makeViolations(), new Set(["src/a.tsx"]));
    expect(result).toEqual({
      mechanical: { source: 0, buildArtifact: 1 },
      guidance: { source: 0, buildArtifact: 1 },
      runtimeOnly: { source: 0, buildArtifact: 1 },
      verifyInSource: { source: 0, buildArtifact: 1 },
    });
  });
});
