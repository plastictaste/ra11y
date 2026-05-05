/**
 * Unit coverage for the MCP response-assembly doctrine linter.
 *
 * The linter walks `src/mcp/**`, `src/output/agent-response/**`,
 * `src/reports/**`, and `src/review/**` for object literals that
 * regress documented headline-counter / ambiguous-field-shape rules.
 * These tests feed synthetic TypeScript sources through the core
 * analyzer (`findResponseAssemblyViolations`) so the invariants are
 * checked independently of the current source tree.
 *
 * The `plan-violations-composite` pattern
 * is the third pattern the analyzer enforces, alongside
 * `newText-empty-with-edit-kind` and `plan-total-findings`.
 */

import { describe, expect, test } from "bun:test";
import type { AllowlistEntry } from "../../../scripts/check-response-assembly.ts";
import { findResponseAssemblyViolations } from "../../../scripts/check-response-assembly.ts";

const NO_ALLOWLIST: readonly AllowlistEntry[] = [];

describe("findResponseAssemblyViolations: plan-violations-composite pattern", () => {
  test("flags `plan: { violations: <numeric literal> }` inside textResult", () => {
    // the flat `plan.violations`
    // headline was deleted because it summed across the four
    // `fixesByClass` lanes. Re-introducing it inside a `textResult`
    // call is the regression this guard catches.
    const src = `
      import { textResult } from "./helpers";
      export function handler() {
        return textResult({
          plan: { violations: 0, notes: 0, summary: "clean" },
          files: [],
          meta: {},
        });
      }
    `;
    const violations = findResponseAssemblyViolations(src, "synthetic.ts", NO_ALLOWLIST);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.pattern).toBe("plan-violations-composite");
    expect(violations[0]?.file).toBe("synthetic.ts");
  });

  test("flags `plan: { violations: 323 }` for any non-zero numeric literal", () => {
    // The dishonesty doesn't depend on the count — even an inflated
    // 323 in a synthetic test would land. The predicate is just
    // "numeric literal," not "literal === 0."
    const src = `
      import { textResult } from "./helpers";
      export function handler() {
        return textResult({
          plan: { violations: 323, notes: 0 },
        });
      }
    `;
    const violations = findResponseAssemblyViolations(src, "synthetic.ts", NO_ALLOWLIST);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.pattern).toBe("plan-violations-composite");
  });

  test("does NOT flag `buildScanPlan({ violations: violations.length })` — that's a function call arg, not a `plan:` literal", () => {
    // The legitimate upstream call site passes `violations.length`
    // INTO `buildScanPlan(...)` so the helper can compute its
    // emit-fixesByClass gate. That's an arg to a CallExpression,
    // not a `plan: { ... }` ObjectLiteral, so it must not trip.
    const src = `
      import { buildScanPlan } from "./scan-assembly";
      import { textResult } from "./helpers";
      export function handler() {
        const violations = [];
        const notes = [];
        const plan = buildScanPlan({
          violations: violations.length,
          notes: notes.length,
          violationsWithoutAnyFix: 0,
          actionableManual: 0,
          untargetedCriteria: 0,
          fixClassCounts: { mechanical: 0, guidance: 0, "runtime-only": 0, "verify-in-source": 0 },
          fixesByClass: { mechanical: 0, guidance: 0, runtimeOnly: 0, verifyInSource: 0 },
        });
        return textResult({ plan, files: [], meta: {} });
      }
    `;
    const violations = findResponseAssemblyViolations(src, "synthetic.ts", NO_ALLOWLIST);
    expect(violations).toHaveLength(0);
  });

  test("does NOT flag a `plan` literal outside textResult / errorResult (e.g. JSON-Schema input shape)", () => {
    // The JSON-Schema `properties` definitions for tool input
    // schemas may reference `violations` — the pattern is scoped to
    // `textResult` / `errorResult` ancestors so non-response shapes
    // are out of scope by construction.
    const src = `
      export const inputSchema = {
        type: "object",
        properties: {
          plan: { violations: 0 },
        },
      };
    `;
    const violations = findResponseAssemblyViolations(src, "synthetic.ts", NO_ALLOWLIST);
    expect(violations).toHaveLength(0);
  });

  test("does NOT flag `plan: { violations: <expression> }` non-literal initializer", () => {
    // The predicate is narrow on numeric literals. A computed
    // `violations` initializer (function call, identifier) inside
    // a `plan:` literal would be unusual but is not what the guard
    // exists to catch — the canonical regression is the
    // composite-headline literal.
    const src = `
      import { textResult } from "./helpers";
      export function handler() {
        const count = 5;
        return textResult({
          plan: { violations: count },
        });
      }
    `;
    const violations = findResponseAssemblyViolations(src, "synthetic.ts", NO_ALLOWLIST);
    expect(violations).toHaveLength(0);
  });

  test("respects allowlist entries for plan-violations-composite", () => {
    const src = `
      import { textResult } from "./helpers";
      export function handler() {
        return textResult({
          plan: { violations: 0, notes: 0 },
        });
      }
    `;
    const allowlist: readonly AllowlistEntry[] = [
      {
        file: "synthetic.ts",
        pattern: "plan-violations-composite",
        reason: "synthetic test allowlist",
      },
    ];
    const violations = findResponseAssemblyViolations(src, "synthetic.ts", allowlist);
    expect(violations).toHaveLength(0);
  });

  test("flags both plan-total-findings and plan-violations-composite when both regress at once", () => {
    // Defensive: the analyzer should report both deletions if a
    // future commit somehow re-introduces both fields together.
    const src = `
      import { textResult } from "./helpers";
      export function handler() {
        return textResult({
          plan: { totalFindings: 100, violations: 50, notes: 0 },
        });
      }
    `;
    const violations = findResponseAssemblyViolations(src, "synthetic.ts", NO_ALLOWLIST);
    const patterns = violations.map((v) => v.pattern).sort();
    expect(patterns).toEqual(["plan-total-findings", "plan-violations-composite"]);
  });
});

describe("findResponseAssemblyViolations: automated-coverage-pass-rate-composite pattern", () => {
  test("flags `automatedCoverage: { … automatedCriteriaPassRate }` inside textResult", () => {
    // the lone scalar bundled
    // `clean` / `untestable` / `withFindings` into one ratio. The
    // singular shape is the canonical checklist envelope on a
    // single-standard call.
    const src = `
      import { textResult } from "./helpers";
      export function handler() {
        return textResult({
          summary: {
            automatedCoverage: { standardId: "wcag22", automatedCriteriaPassRate: 45 },
          },
        });
      }
    `;
    const violations = findResponseAssemblyViolations(src, "synthetic.ts", NO_ALLOWLIST);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.pattern).toBe("automated-coverage-pass-rate-composite");
  });

  test("flags an array element under `automatedCoverage: [{ … }, …]` (multi-standard path)", () => {
    // The multi-standard path keeps an array of per-standard glosses;
    // the predicate must catch the regression on any element.
    const src = `
      import { textResult } from "./helpers";
      export function handler() {
        return textResult({
          summary: {
            automatedCoverage: [
              { standardId: "wcag22", automatedCriteriaPassRate: 45 },
              { standardId: "section508", criteriaWithRulesAllClean: 1, criteriaWithoutEligibleInputs: 0 },
            ],
          },
        });
      }
    `;
    const violations = findResponseAssemblyViolations(src, "synthetic.ts", NO_ALLOWLIST);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.pattern).toBe("automated-coverage-pass-rate-composite");
  });

  test("does NOT flag the sibling `coverage` tool's per-standard `automatedCriteriaPassRate`", () => {
    // The `coverage` tool surfaces `automatedCriteriaPassRate` at the
    // top level of each per-standard entry alongside the structured
    // counter split. That shape is out of scope because the value
    // never sits under an `automatedCoverage:` key.
    const src = `
      import { textResult } from "./helpers";
      export function handler() {
        return textResult({
          standardId: "wcag22",
          automatedCriteriaPassRate: 73,
          criteriaEvaluated: 30,
          criteriaClean: 22,
          criteriaWithFindings: 8,
        });
      }
    `;
    const violations = findResponseAssemblyViolations(src, "synthetic.ts", NO_ALLOWLIST);
    expect(violations).toHaveLength(0);
  });

  test("does NOT flag `automatedCriteriaPassRate` outside textResult / errorResult", () => {
    // Schema fixtures, JSDoc samples, or unit-test helpers carrying
    // the literal stay out of scope by the response-builder ascent.
    const src = `
      export const fixture = {
        summary: {
          automatedCoverage: { standardId: "wcag22", automatedCriteriaPassRate: 45 },
        },
      };
    `;
    const violations = findResponseAssemblyViolations(src, "synthetic.ts", NO_ALLOWLIST);
    expect(violations).toHaveLength(0);
  });

  test("respects allowlist entries for automated-coverage-pass-rate-composite", () => {
    const src = `
      import { textResult } from "./helpers";
      export function handler() {
        return textResult({
          summary: {
            automatedCoverage: { standardId: "wcag22", automatedCriteriaPassRate: 45 },
          },
        });
      }
    `;
    const allowlist: readonly AllowlistEntry[] = [
      {
        file: "synthetic.ts",
        pattern: "automated-coverage-pass-rate-composite",
        reason: "synthetic test allowlist",
      },
    ];
    const violations = findResponseAssemblyViolations(src, "synthetic.ts", allowlist);
    expect(violations).toHaveLength(0);
  });
});
