/**
 * Audit-style invariant: across every rule in {@link BUILTIN_RULES},
 * an `AgentFinding` derived from a violation that does NOT carry a
 * mechanical edit (`fixPaths.primary.edit`) must NOT carry
 * `category: "auto-fix"`.
 *
 * Doctrine: docs/kb/architecture/ai-first-consumer.md "Reason /
 * priority / fix-description must agree across all three channels."
 * `fixClass: "runtime-only"` declares the rule has no static edit
 * available — only runtime verification (DOM, QA) can decide. Shipping
 * `category: "auto-fix"` on the same finding is the canonical
 * contradiction; pre-fix, every `motion/pause-stop-hide` emission
 * carrying a prose `suggestion` shipped exactly that pair. The same
 * shape would have surfaced on `tooltip/dismissable` and
 * `motion/animation-from-interactions` (the other `runtime-only`
 * rules) on any finding that ships a prose `suggestion`.
 *
 * This test walks every loaded rule, synthesizes a violation with a
 * non-empty prose `suggestion` and no `fixPaths.primary.edit`, runs it
 * through {@link buildAgentFinding}, and pins the invariant: when no
 * mechanical edit is present, the finding routes to
 * `category: "review"` regardless of `fixClass` — and in particular,
 * `runtime-only` and `guidance` rules can never claim `auto-fix` from
 * a prose suggestion alone.
 *
 * Survives refactors of `categorize`'s implementation: the doctrinal
 * predicate is "no edit ⇒ no auto-fix," and the test exercises every
 * rule's `fixClass` against that predicate. Adding a new
 * `runtime-only` rule next month is automatically covered.
 */

import { describe, expect, it } from "bun:test";
import { buildAgentFinding } from "../../../../src/output/agent-response/build-finding.ts";
import { BUILTIN_RULES } from "../../../../src/rules/index.ts";
import type { Violation } from "../../../../src/types/violation.ts";
import { withFindingId } from "../../../helpers/make-violation.ts";

function syntheticViolation(ruleId: string, fixClass: Violation["fixClass"]): Violation {
  return withFindingId({
    ruleId,
    fixClass,
    criteria: ["wcag22:1.1.1"],
    severity: "error",
    location: { filePath: "synthetic.tsx", line: 1, column: 1 },
    message: `synthetic ${ruleId}`,
    // Non-empty prose suggestion: pre-fix, this branch of categorize()
    // upgraded the finding to `category: "auto-fix"` regardless of
    // whether a static edit was available. The doctrinal closure
    // anchors auto-fix to `fixPaths.primary.edit`, so this synthetic
    // violation must route to `category: "review"`.
    suggestion: "Synthetic prose guidance for the no-edit branch.",
  });
}

describe("category-vs-fixClass contradiction invariant — every BUILTIN_RULES rule", () => {
  it("BUILTIN_RULES is non-empty (sanity)", () => {
    expect(BUILTIN_RULES.length).toBeGreaterThan(0);
  });

  it("no rule produces category: 'auto-fix' on a finding without a mechanical edit", () => {
    const offenders: { ruleId: string; fixClass: string }[] = [];
    for (const rule of BUILTIN_RULES) {
      const finding = buildAgentFinding(syntheticViolation(rule.id, rule.fixClass));
      if (finding.category === "auto-fix") {
        offenders.push({ ruleId: rule.id, fixClass: rule.fixClass });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every runtime-only rule routes to category: 'review' (no auto-fix possible)", () => {
    // The acute regression class: a runtime-only rule by definition
    // cannot ship `category: "auto-fix"` because no static edit is
    // available. Pin the invariant per-rule so a future rule that
    // tries to ship a mechanical edit alongside `fixClass:
    // "runtime-only"` (an internally inconsistent rule shape) is
    // caught at unit-level.
    const runtimeOnlyRules = BUILTIN_RULES.filter((r) => r.fixClass === "runtime-only");
    expect(runtimeOnlyRules.length).toBeGreaterThan(0);
    for (const rule of runtimeOnlyRules) {
      const finding = buildAgentFinding(syntheticViolation(rule.id, rule.fixClass));
      expect({
        ruleId: rule.id,
        fixClass: finding.fixClass,
        category: finding.category,
      }).toEqual({
        ruleId: rule.id,
        fixClass: "runtime-only",
        category: "review",
      });
    }
  });

  it("every guidance rule routes to category: 'review' on a no-edit finding", () => {
    // Guidance findings ship prose only — no static edit by definition.
    // Same predicate as the runtime-only invariant, different fixClass
    // lane.
    const guidanceRules = BUILTIN_RULES.filter((r) => r.fixClass === "guidance");
    expect(guidanceRules.length).toBeGreaterThan(0);
    for (const rule of guidanceRules) {
      const finding = buildAgentFinding(syntheticViolation(rule.id, rule.fixClass));
      expect(finding.category).toBe("review");
    }
  });
});
