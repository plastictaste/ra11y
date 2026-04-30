/**
 * Pins the per-rule count parity between
 * `plan.topRules[].count` (computed in `scan-assembly.ts`'s
 * `computeTopRules`) and
 * `warningsDetails.truncated_files_dropped.topDroppedRules[].droppedCount`
 * (computed in `truncated-files-dropped.ts`'s
 * `computeTruncatedFilesDroppedWarning`).
 *
 * Both axes describe the same conceptual quantity — "how many findings
 * of rule X" — and must count the same severity slice. A mismatch
 * produces a within-response cross-field count drift the agent has no
 * way to reconcile silently (the canonical regression: `count: 3234` vs
 * `droppedCount: 3327` on a bulk-vendor scan, where `contrast/minimum`
 * had emitted ~93 info-severity findings on hedged-uncertainty branches
 * that crossed the dropped-subset boundary but were excluded from
 * `topRules`).
 *
 * `computeTopRules` filters out info-severity findings to keep the
 * count axis aligned with `plan.fixesByClass` headlines (also
 * error+warning-only). This test verifies
 * `computeTruncatedFilesDroppedWarning` applies the same filter so
 * `droppedCount` ≤ `count` for every rule on identical input.
 */

import { describe, expect, it } from "bun:test";
import { computeTopRules } from "../../../src/mcp/scan-assembly.ts";
import { computeTruncatedFilesDroppedWarning } from "../../../src/mcp/truncated-files-dropped.ts";

describe("computeTruncatedFilesDroppedWarning — info-severity exclusion (count parity with computeTopRules)", () => {
  it("skips info-severity findings so `droppedCount` matches the same slice `topRules.count` measures", () => {
    // Mixed-severity inventory: error + warning + info findings of the
    // same rule across two files. `computeTopRules` filters info;
    // `computeTruncatedFilesDroppedWarning` must do the same.
    const files = [
      {
        path: "src/a.tsx",
        findings: [
          { ruleId: "contrast/minimum", severity: "error" },
          { ruleId: "contrast/minimum", severity: "info" },
          { ruleId: "contrast/minimum", severity: "warning" },
        ],
      },
      {
        path: "src/b.tsx",
        findings: [
          { ruleId: "contrast/minimum", severity: "info" },
          { ruleId: "keyboard/handler-missing", severity: "error" },
        ],
      },
    ];

    const topRules = computeTopRules(files);
    const droppedPayload = computeTruncatedFilesDroppedWarning(files).payload;

    const topRulesByRule = new Map(topRules.map((r) => [r.ruleId, r.count]));
    expect(topRulesByRule.get("contrast/minimum")).toBe(2);
    expect(topRulesByRule.get("keyboard/handler-missing")).toBe(1);

    expect(droppedPayload).toBeDefined();
    const droppedByRule = new Map(droppedPayload?.topDroppedRules.map((r) => [r.ruleId, r.droppedCount]));
    // The two info-severity findings on `contrast/minimum` are
    // excluded — droppedCount tracks the same error+warning slice.
    expect(droppedByRule.get("contrast/minimum")).toBe(2);
    expect(droppedByRule.get("keyboard/handler-missing")).toBe(1);
  });

  it("returns undefined when the dropped subset carried only info-severity findings", () => {
    // Per the present-when-meaningful contract: an info-only dropped
    // subset means no error/warning findings disappeared from the
    // wire, so the `truncated_files_dropped` warning code must NOT
    // fire (its predicate is "files-with-actionable-findings dropped",
    // matching the headline severity slice).
    const out = computeTruncatedFilesDroppedWarning([
      {
        path: "src/a.tsx",
        findings: [{ ruleId: "contrast/minimum", severity: "info" }],
      },
    ]);
    expect(out.payload).toBeUndefined();
  });

  it("preserves rule-level `droppedCount` ≤ `count` invariant on every rule for an identical input", () => {
    // Property-style: synthesize a randomized mix of severities across
    // several rules; the per-rule `droppedCount` must never exceed the
    // per-rule `count` on the same input. This is the within-response
    // cross-field invariant the bug report on
    // `count: 3234 / droppedCount: 3327` violated.
    const ruleIds = ["contrast/minimum", "keyboard/handler-missing", "aria/icon-child-missing-aria-hidden"];
    const severities = ["error", "warning", "info"] as const;
    const files: { path: string; findings: { ruleId: string; severity: string }[] }[] = [];
    let seed = 7;
    const rand = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    for (let f = 0; f < 30; f += 1) {
      const findings: { ruleId: string; severity: string }[] = [];
      const findingCount = Math.floor(rand() * 10) + 1;
      for (let i = 0; i < findingCount; i += 1) {
        findings.push({
          ruleId: ruleIds[Math.floor(rand() * ruleIds.length)] as string,
          severity: severities[Math.floor(rand() * severities.length)] as string,
        });
      }
      files.push({ path: `src/file-${f}.tsx`, findings });
    }

    const topRules = computeTopRules(files);
    const dropped = computeTruncatedFilesDroppedWarning(files).payload;
    const topRulesByRule = new Map(topRules.map((r) => [r.ruleId, r.count]));
    if (dropped !== undefined) {
      for (const { ruleId, droppedCount } of dropped.topDroppedRules) {
        const expected = topRulesByRule.get(ruleId) ?? 0;
        // Identical input, identical filter — counts must match
        // exactly when the dropped subset is the whole inventory
        // (the slim-envelope path's framing). The invariant
        // `droppedCount ≤ count` is the looser form for the
        // density-cap path (dropped subset ⊂ whole), but on this
        // fixture both axes see the same files, so equality holds.
        expect(droppedCount).toBe(expected);
      }
    }
  });
});
