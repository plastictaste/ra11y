/**
 * Tests for the co-firing rule merger.
 *
 * Pure unit tests over `mergeCoFiringRules` exercise the pair-folding
 * logic directly with synthetic Violations; an end-to-end scanner
 * test exercises the wiring in `runScan` against real source so the
 * production pairs (`navigation/href-empty-fragment` ↔
 * `navigation/link-descriptive-text`,  `forms/placeholder-as-label` ↔
 * `forms/labels-required`) actually fold on real inputs.
 */

import { describe, expect, it } from "bun:test";
import { mergeCoFiringRules } from "../../../src/engine/cofire-merge.ts";
import { type ParsedFile, runScan } from "../../../src/engine/scanner.ts";
import { parseHtml, parseTsx } from "../../../src/input/parsers/index.ts";
import { BUILTIN_RULES } from "../../../src/rules/index.ts";
import { section508 } from "../../../src/standards/section508/standard.ts";
import { wcag22 } from "../../../src/standards/wcag22/standard.ts";
import type { Ast } from "../../../src/types/ast.ts";
import type { Violation } from "../../../src/types/violation.ts";
import { withFindingId } from "../../helpers/make-violation.ts";

function makeViolation(args: {
  readonly ruleId: string;
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly criteria?: readonly string[];
  readonly criteriaTitles?: readonly string[];
  readonly severity?: Violation["severity"];
  readonly message?: string;
}): Violation {
  return withFindingId({
    ruleId: args.ruleId,
    fixClass: "guidance",
    criteria: args.criteria ?? [],
    ...(args.criteriaTitles === undefined ? {} : { criteriaTitles: args.criteriaTitles }),
    severity: args.severity ?? "warning",
    location: { filePath: args.filePath, line: args.line, column: args.column },
    message: args.message ?? `${args.ruleId} fired`,
  });
}

function htmlFile(filePath: string, source: string): ParsedFile {
  const r = parseHtml(source);
  const ast: Ast = { language: "html", root: r.root, errors: r.errors };
  return { filePath, source, ast };
}

function tsxFile(filePath: string, source: string): ParsedFile {
  const r = parseTsx(source);
  const ast: Ast = { language: "tsx", root: r.root, errors: r.errors };
  return { filePath, source, ast };
}

describe("mergeCoFiringRules — unit", () => {
  it("folds the secondary into the primary when both fire at the same (file, line, column)", () => {
    const primary = makeViolation({
      ruleId: "navigation/href-empty-fragment",
      filePath: "page.html",
      line: 5,
      column: 3,
      criteria: ["wcag22:4.1.2", "wcag22:2.1.1"],
      criteriaTitles: ["Name, Role, Value", "Keyboard"],
      severity: "error",
      message: "Empty href fragment",
    });
    const secondary = makeViolation({
      ruleId: "navigation/link-descriptive-text",
      filePath: "page.html",
      line: 5,
      column: 3,
      criteria: ["wcag22:2.4.4", "wcag22:4.1.2"],
      criteriaTitles: ["Link Purpose", "Name, Role, Value"],
      severity: "warning",
    });
    const merged = mergeCoFiringRules([primary, secondary]);
    expect(merged).toHaveLength(1);
    const only = merged[0];
    if (!only) throw new Error("expected one merged finding");
    // Primary identity preserved.
    expect(only.ruleId).toBe("navigation/href-empty-fragment");
    expect(only.severity).toBe("error");
    expect(only.message).toBe("Empty href fragment");
    expect(only.findingId).toBe(primary.findingId);
    // Criteria union with index-aligned titles, primary first then
    // secondary, de-duplicated.
    expect(only.criteria).toEqual(["wcag22:4.1.2", "wcag22:2.1.1", "wcag22:2.4.4"]);
    expect(only.criteriaTitles).toEqual(["Name, Role, Value", "Keyboard", "Link Purpose"]);
  });

  it("folds placeholder-as-label / labels-required at the same input element", () => {
    const primary = makeViolation({
      ruleId: "forms/placeholder-as-label",
      filePath: "form.html",
      line: 10,
      column: 5,
      criteria: ["wcag22:3.3.2"],
      severity: "warning",
    });
    const secondary = makeViolation({
      ruleId: "forms/labels-required",
      filePath: "form.html",
      line: 10,
      column: 5,
      criteria: ["wcag22:1.3.1", "wcag22:3.3.2"],
      severity: "error",
    });
    const merged = mergeCoFiringRules([primary, secondary]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.ruleId).toBe("forms/placeholder-as-label");
    // Primary's severity ("warning") is preserved — folding the more
    // severe secondary does NOT escalate the merged finding's severity.
    // Specificity wins over severity by design.
    expect(merged[0]?.severity).toBe("warning");
    expect(merged[0]?.criteria).toEqual(["wcag22:3.3.2", "wcag22:1.3.1"]);
  });

  it("does NOT fold when the two findings are at different columns on the same line", () => {
    const a = makeViolation({
      ruleId: "navigation/href-empty-fragment",
      filePath: "page.html",
      line: 5,
      column: 3,
      criteria: ["wcag22:4.1.2"],
    });
    const b = makeViolation({
      ruleId: "navigation/link-descriptive-text",
      filePath: "page.html",
      line: 5,
      column: 9,
      criteria: ["wcag22:2.4.4"],
    });
    const merged = mergeCoFiringRules([a, b]);
    expect(merged).toHaveLength(2);
  });

  it("does NOT fold when only the secondary fires (no primary at the location)", () => {
    // `link-descriptive-text` on a real anchor with descriptive href —
    // no `href-empty-fragment` partner — should pass through unchanged.
    const v = makeViolation({
      ruleId: "navigation/link-descriptive-text",
      filePath: "page.html",
      line: 5,
      column: 3,
      criteria: ["wcag22:2.4.4"],
    });
    const merged = mergeCoFiringRules([v]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.ruleId).toBe("navigation/link-descriptive-text");
  });

  it("does NOT fold across files", () => {
    const a = makeViolation({
      ruleId: "navigation/href-empty-fragment",
      filePath: "page-a.html",
      line: 5,
      column: 3,
      criteria: ["wcag22:4.1.2"],
    });
    const b = makeViolation({
      ruleId: "navigation/link-descriptive-text",
      filePath: "page-b.html",
      line: 5,
      column: 3,
      criteria: ["wcag22:2.4.4"],
    });
    const merged = mergeCoFiringRules([a, b]);
    expect(merged).toHaveLength(2);
  });

  it("preserves primary's other fields (suggestion, fix, snippet) untouched", () => {
    const primary = withFindingId({
      ruleId: "navigation/href-empty-fragment",
      fixClass: "verify-in-source",
      criteria: ["wcag22:4.1.2"],
      criteriaTitles: ["Name, Role, Value"],
      severity: "error",
      location: { filePath: "page.html", line: 5, column: 3 },
      message: "Primary message",
      suggestion: "Replace with real URL or button",
      snippet: '<a href="#">x</a>',
    });
    const secondary = makeViolation({
      ruleId: "navigation/link-descriptive-text",
      filePath: "page.html",
      line: 5,
      column: 3,
      criteria: ["wcag22:2.4.4"],
      criteriaTitles: ["Link Purpose"],
    });
    const merged = mergeCoFiringRules([primary, secondary]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.suggestion).toBe("Replace with real URL or button");
    expect(merged[0]?.snippet).toBe('<a href="#">x</a>');
    expect(merged[0]?.message).toBe("Primary message");
  });

  it("returns the input array reference unchanged when no fold applies", () => {
    const inputs: readonly Violation[] = [
      makeViolation({
        ruleId: "navigation/link-descriptive-text",
        filePath: "page.html",
        line: 1,
        column: 1,
        criteria: ["wcag22:2.4.4"],
      }),
    ];
    const merged = mergeCoFiringRules(inputs);
    // Identity check: when no pair matches, the helper returns the
    // input list directly so callers don't pay an unnecessary copy.
    expect(merged).toBe(inputs);
  });

  it("handles empty input", () => {
    const merged = mergeCoFiringRules([]);
    expect(merged).toEqual([]);
  });

  it("emits criteriaTitles only when at least one input had titles", () => {
    const primary = makeViolation({
      ruleId: "navigation/href-empty-fragment",
      filePath: "page.html",
      line: 5,
      column: 3,
      criteria: ["wcag22:4.1.2"],
      // No criteriaTitles on either side.
    });
    const secondary = makeViolation({
      ruleId: "navigation/link-descriptive-text",
      filePath: "page.html",
      line: 5,
      column: 3,
      criteria: ["wcag22:2.4.4"],
    });
    const merged = mergeCoFiringRules([primary, secondary]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.criteria).toEqual(["wcag22:4.1.2", "wcag22:2.4.4"]);
    expect(merged[0]?.criteriaTitles).toBeUndefined();
  });

  it("falls back to ID-as-title when one side has titles and the other does not", () => {
    const primary = makeViolation({
      ruleId: "navigation/href-empty-fragment",
      filePath: "page.html",
      line: 5,
      column: 3,
      criteria: ["wcag22:4.1.2"],
      criteriaTitles: ["Name, Role, Value"],
    });
    const secondary = makeViolation({
      ruleId: "navigation/link-descriptive-text",
      filePath: "page.html",
      line: 5,
      column: 3,
      criteria: ["wcag22:2.4.4"],
      // No titles — merger should fall back to the ID itself rather
      // than emit `""` (per CLAUDE.md §1 "Ambiguous field shapes").
    });
    const merged = mergeCoFiringRules([primary, secondary]);
    expect(merged[0]?.criteriaTitles).toEqual(["Name, Role, Value", "wcag22:2.4.4"]);
  });
});

describe("co-firing merge — end-to-end via runScan", () => {
  it('`<a href="#"><i class="fa-..."></i></a>` produces ONE merged finding citing both rules\' criteria', () => {
    const file = htmlFile(
      "page.html",
      `<!doctype html><html lang="en"><head><title>x</title></head><body><a href="#"><i class="fa fa-twitter"></i></a></body></html>`,
    );
    const products = runScan({
      standards: [wcag22, section508],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: [file],
    });
    const onAnchor = products.result.violations.filter(
      (v) =>
        v.location.filePath === "page.html" &&
        (v.ruleId === "navigation/href-empty-fragment" ||
          v.ruleId === "navigation/link-descriptive-text"),
    );
    // Pre-merge there would be 2; post-merge exactly 1.
    expect(onAnchor).toHaveLength(1);
    const only = onAnchor[0];
    if (!only) throw new Error("expected the merged finding");
    expect(only.ruleId).toBe("navigation/href-empty-fragment");
    // Both rules' criteria are present on the merged finding so the
    // coverage / vpat / checklist surfaces all see the same set of
    // exercised criteria they would have seen pre-merge.
    expect(only.criteria).toContain("wcag22:4.1.2");
    expect(only.criteria).toContain("wcag22:2.4.4");
  });

  it('`<input placeholder="...">` produces ONE merged finding', () => {
    const file = htmlFile(
      "form.html",
      `<!doctype html><html lang="en"><head><title>x</title></head><body><form><input type="email" placeholder="Email"></form></body></html>`,
    );
    const products = runScan({
      standards: [wcag22, section508],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: [file],
    });
    const onInput = products.result.violations.filter(
      (v) =>
        v.location.filePath === "form.html" &&
        (v.ruleId === "forms/labels-required" || v.ruleId === "forms/placeholder-as-label"),
    );
    expect(onInput).toHaveLength(1);
    const only = onInput[0];
    if (!only) throw new Error("expected the merged finding");
    expect(only.ruleId).toBe("forms/placeholder-as-label");
    // Both rules' criteria visible on the merged finding.
    expect(only.criteria).toContain("wcag22:3.3.2");
    expect(only.criteria).toContain("wcag22:1.3.1");
  });

  it("per-rule coverage tallies post-merge so findingsEmitted agrees with visible findings", () => {
    // Cross-surface count invariant
    // (docs/kb/architecture/ai-first-consumer.md): when the secondary
    // rule fires and is folded into the primary, the agent-facing
    // violation list drops the secondary record. The per-rule
    // coverage row must reflect that: `findingsEmitted` counts the
    // visible findings on the response, not the pre-merge tally. The
    // merged primary already carries the secondary's `criteria`
    // union, so cross-criterion coverage stays preserved on the
    // surviving record — no signal is lost, the tally just matches
    // what the agent reads in `findings[]`.
    const file = htmlFile(
      "form.html",
      `<!doctype html><html lang="en"><head><title>x</title></head><body><form><input type="email" placeholder="Email"></form></body></html>`,
    );
    const products = runScan({
      standards: [wcag22, section508],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: [file],
    });
    const labelsRequiredRow = products.perRuleCoverage.find(
      (r) => r.ruleId === "forms/labels-required",
    );
    const placeholderRow = products.perRuleCoverage.find(
      (r) => r.ruleId === "forms/placeholder-as-label",
    );
    // Primary (placeholder-as-label) survived the merge — its row
    // reports the emission count that ships in `findings[]`.
    const visiblePlaceholder = products.result.violations.filter(
      (v) => v.ruleId === "forms/placeholder-as-label",
    ).length;
    expect(placeholderRow?.findingsEmitted).toBe(visiblePlaceholder);
    expect(visiblePlaceholder).toBeGreaterThanOrEqual(1);
    // Secondary (labels-required) was folded into the primary at the
    // same `(file, line, column)`. The agent sees zero
    // `forms/labels-required` entries on the response; the per-rule
    // row honestly reports `findingsEmitted: 0`. The merged primary's
    // `criteria` array still carries the wcag22:1.3.1 / 4.1.2 union
    // (asserted in the test above).
    const visibleLabels = products.result.violations.filter(
      (v) => v.ruleId === "forms/labels-required",
    ).length;
    expect(labelsRequiredRow?.findingsEmitted).toBe(visibleLabels);
    expect(visibleLabels).toBe(0);
  });

  it("does NOT fold when only one of the pair fires (real link with descriptive text)", () => {
    // `<a href="/docs">Read the docs</a>` should fire neither
    // `href-empty-fragment` nor `link-descriptive-text`. The clean
    // case is a smoke test that the merger doesn't accidentally
    // suppress on a different shape.
    const file = htmlFile(
      "page.html",
      `<!doctype html><html lang="en"><head><title>x</title></head><body><a href="/docs">Read the docs</a></body></html>`,
    );
    const products = runScan({
      standards: [wcag22, section508],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: [file],
    });
    const onAnchor = products.result.violations.filter(
      (v) =>
        v.ruleId === "navigation/href-empty-fragment" ||
        v.ruleId === "navigation/link-descriptive-text",
    );
    expect(onAnchor).toHaveLength(0);
  });

  it('JSX: `<a href="#"><i className="fa-..."/></a>` folds the same way HTML does', () => {
    const file = tsxFile(
      "Page.tsx",
      `export const Page = () => (
        <a href="#"><i className="fa fa-twitter" /></a>
      );`,
    );
    const products = runScan({
      standards: [wcag22, section508],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: [file],
    });
    const onAnchor = products.result.violations.filter(
      (v) =>
        v.ruleId === "navigation/href-empty-fragment" ||
        v.ruleId === "navigation/link-descriptive-text",
    );
    expect(onAnchor).toHaveLength(1);
    expect(onAnchor[0]?.ruleId).toBe("navigation/href-empty-fragment");
  });
});
