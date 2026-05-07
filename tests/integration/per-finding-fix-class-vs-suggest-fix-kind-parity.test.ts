/**
 * Integration test: per-finding `fixClass` lane must agree with the
 * per-call `suggest_fix.kind` discriminator on the same `(rule, file,
 * line)` triple.
 *
 * Doctrine — `docs/kb/architecture/ai-first-consumer.md` "Per-call
 * shape must agree with per-class plan tally": when an agent budgets
 * from `plan.fixesByClass` (or its sibling per-finding `fixClass`
 * stamp on `scan_file.findings[]`), the lane it lands in must agree
 * with the lane `suggest_fix(ruleId, file, line).kind` would route
 * the same finding into. The historical regression: per-finding
 * `fixClass: "verify-in-source"` (counted in
 * `plan.fixesByClass.verifyInSource`) shipped alongside per-call
 * `suggest_fix.kind: "suppress-recommended"` for the same finding —
 * the plan tally counted in one lane, the per-call surface in
 * another. The closure routes per-finding `fixClass` through the
 * same suggestion-text predicate that drives `suggest_fix.kind`
 * (presence of `ra11y-disable` / `suppress with` in the explanation
 * → `fixClass: "suppress-recommended"` AND `kind:
 * "suppress-recommended"`).
 *
 * Test strategy: build a fixture that triggers a rule whose
 * suggestion prose names the source-level disable pragma
 * (`semantics/heading-hierarchy` on a body with no headings — the
 * rule's missing-h1-on-full-page emit appends "If this page is a
 * fragment …, suppress with <!-- ra11y-disable wcag22:1.3.1 -->"),
 * then for each emitted violation drive `buildAgentFinding` and
 * `buildSuggestFixPayload` and assert the partition is consistent.
 */

import { describe, expect, it } from "bun:test";

import { runScan } from "../../src/engine/scanner.ts";
import { parseHtml } from "../../src/input/parsers/html.ts";
import { buildSuggestFixPayload } from "../../src/mcp/tool-suggest-fix-internals.ts";
import { buildAgentFinding } from "../../src/output/agent-response/build-finding.ts";
import { BUILTIN_RULES } from "../../src/rules/index.ts";
import { BUILTIN_STANDARDS } from "../../src/standards/index.ts";
import type { Ast } from "../../src/types/ast.ts";

interface FileSpec {
  readonly filePath: string;
  readonly source: string;
}

function parseFile(spec: FileSpec): { source: string; ast: Ast } {
  const parsed = parseHtml(spec.source);
  return {
    source: spec.source,
    ast: { language: "html", root: parsed.root, errors: parsed.errors },
  };
}

describe("per-finding fixClass agrees with suggest_fix.kind on (rule, file, line)", () => {
  // The `semantics/heading-hierarchy` rule's missing-h1 emit on a
  // headingless body adds an "If this page is a fragment …, suppress
  // with <!-- ra11y-disable wcag22:1.3.1 -->" tail to its suggestion
  // prose. That's the canonical case where the per-call shape returns
  // `kind: "suppress-recommended"` and the per-finding `fixClass`
  // must match.
  const file: FileSpec = {
    filePath: "/page.html",
    source:
      '<!doctype html><html lang="en"><body><div>one</div><div>two</div><div>three</div></body></html>',
  };

  it("a suppression-flavored finding stamps fixClass: 'suppress-recommended' AND suggest_fix.kind: 'suppress-recommended'", () => {
    const built = { filePath: file.filePath, ...parseFile(file) };
    const { result } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: [built],
    });
    const v = result.violations.find((x) => x.ruleId === "semantics/heading-hierarchy");
    expect(v).toBeDefined();
    if (!v) throw new Error("expected a heading-hierarchy violation on this fixture");

    // Confirm the rule's emission is suppression-flavored — sentinel
    // for the partition predicate.
    expect(v.suggestion).toContain("ra11y-disable");

    // Per-finding lane: `buildAgentFinding` must reroute via the
    // shared predicate, producing `fixClass: "suppress-recommended"`
    // even though the rule's declared `Violation.fixClass` is
    // `verify-in-source` (or whatever the rule registry sets).
    const finding = buildAgentFinding(v);
    expect(finding.fixClass).toBe("suppress-recommended");

    // Per-call lane: `buildSuggestFixPayload` must return
    // `kind: "suppress-recommended"` on the same finding triple.
    const payload = buildSuggestFixPayload({
      ruleId: v.ruleId,
      line: v.location.line,
      match: v,
      sourceContext: file.source,
      source: file.source,
      filePath: file.filePath,
    });
    expect(payload["kind"]).toBe("suppress-recommended");

    // The two surfaces partition the same finding into the same lane:
    // per-finding `fixClass` and per-call `kind` are byte-identical
    // for the suppress-recommended case. Per-call `kind` uses
    // `"edit"` / `"guidance"` for the other lanes — the partition
    // discriminator is one-to-one only on `"suppress-recommended"`.
    expect(finding.fixClass).toBe(payload["kind"] as string);
  });

  it("an honest mechanical-edit finding keeps its declared fixClass and ships kind: 'edit'", () => {
    // Sanity sibling: a rule that ships a real mechanical edit (no
    // suppression-flavored prose) must NOT reroute to
    // `suppress-recommended` on either surface. Pin the negative case
    // so the rerouting predicate doesn't accidentally fire on every
    // guidance-shaped emission.
    const mechFile: FileSpec = {
      filePath: "/redundant.html",
      source: '<button role="button">Save</button>',
    };
    const mechBuilt = { filePath: mechFile.filePath, ...parseFile(mechFile) };
    const { result } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: [mechBuilt],
    });
    const v = result.violations.find((x) => x.ruleId === "aria/redundant-role-on-host-element");
    expect(v).toBeDefined();
    if (!v) throw new Error("expected an aria/redundant-role violation on this fixture");

    const finding = buildAgentFinding(v);
    expect(finding.fixClass).toBe("mechanical");

    const payload = buildSuggestFixPayload({
      ruleId: v.ruleId,
      line: v.location.line,
      match: v,
      sourceContext: mechFile.source,
      source: mechFile.source,
      filePath: mechFile.filePath,
    });
    expect(payload["kind"]).toBe("edit");
  });

  it("plan.fixesByClass.suppressRecommended count agrees with the count of findings whose suggest_fix.kind is 'suppress-recommended'", () => {
    // Ranged invariant — across the same scan, the number of
    // findings stamped `fixClass: "suppress-recommended"` must equal
    // the number for which `suggest_fix.kind === "suppress-recommended"`.
    // Pins the partition equality at the response level, not just
    // the single-finding axis.
    const built = { filePath: file.filePath, ...parseFile(file) };
    const { result } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: [built],
    });
    const errorWarning = result.violations.filter((v) => v.severity !== "info");

    let perFindingSuppress = 0;
    let perCallSuppress = 0;
    for (const v of errorWarning) {
      const finding = buildAgentFinding(v);
      if (finding.fixClass === "suppress-recommended") perFindingSuppress += 1;
      const payload = buildSuggestFixPayload({
        ruleId: v.ruleId,
        line: v.location.line,
        match: v,
        sourceContext: file.source,
        source: file.source,
        filePath: file.filePath,
      });
      if (payload["kind"] === "suppress-recommended") perCallSuppress += 1;
    }
    expect(perFindingSuppress).toBe(perCallSuppress);
    // Sanity: at least one finding routed into the suppress lane on
    // this fixture, otherwise the equality test passes vacuously.
    expect(perFindingSuppress).toBeGreaterThan(0);
  });
});
