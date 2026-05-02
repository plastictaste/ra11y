/**
 * Integration test: per-call `suggest_fix` `kind: "suppress-recommended"`
 * invariants.
 *
 * Doctrine — `docs/kb/architecture/ai-first-consumer.md`
 * "Per-call shape must agree with per-class plan tally" extended to
 * the suppress-recommended discriminator: when a violation's
 * suggestion text mentions the source-level disable pragma
 * (`ra11y-disable` / `suppress with`), suggest_fix returns
 * `kind: "suppress-recommended"` rather than `kind: "guidance"`.
 * The shape carries:
 *
 *   - `primary.explanation` — the original prose verbatim
 *   - `pragma` — the canonical paste-ready pragma string keyed off
 *     the file extension and the violation's first criterion
 *   - `criterionId` — the criterion the pragma scopes to
 *   - NO `newText` field, NO `fixPaths.edit` — there is no edit to
 *     apply, just a pragma the agent pastes after verifying.
 *
 * The plan-tally side mirrors via `plan.fixesByClass.suppressRecommended`
 * (pinned by the unit suite); this integration suite pins the per-call
 * shape against real rule emissions.
 */

import { describe, expect, it } from "bun:test";

import { runScan } from "../../src/engine/scanner.ts";
import { parseHtml } from "../../src/input/parsers/html.ts";
import { buildSuggestFixPayload } from "../../src/mcp/tool-suggest-fix-internals.ts";
import { BUILTIN_RULES } from "../../src/rules/index.ts";
import { BUILTIN_STANDARDS } from "../../src/standards/index.ts";
import type { Ast } from "../../src/types/ast.ts";
import type { Violation } from "../../src/types/violation.ts";

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

describe("suggest_fix: kind: 'suppress-recommended' discriminator", () => {
  // The `semantics/heading-hierarchy` rule's missing-h1 emit on a
  // headingless body adds an "If this page is a fragment …, suppress
  // with <!-- ra11y-disable wcag22:1.3.1 -->" tail to its suggestion
  // prose. That's the canonical shape the new discriminator partitions
  // away from generic `kind: "guidance"`: the rule conceded the
  // criterion may not apply on this substrate and points the agent
  // at the source-level disable.
  const file: FileSpec = {
    filePath: "/page.html",
    // Page-shape: ≥3 visible descendants under <body> with no
    // headings and no landmark — `looksLikeFullPage` returns true via
    // the empty-structural-shell branch and `heading-hierarchy` emits
    // its missing-h1-on-full-page variant whose suggestion text
    // names the source-level disable pragma.
    source:
      '<!doctype html><html lang="en"><body><div>one</div><div>two</div><div>three</div></body></html>',
  };

  function findHeadingHierarchyViolation(): Violation {
    const built = { filePath: file.filePath, ...parseFile(file) };
    const { result } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: [built],
    });
    const v = result.violations.find((x) => x.ruleId === "semantics/heading-hierarchy");
    if (!v) throw new Error("expected a heading-hierarchy violation on this fixture");
    return v as Violation;
  }

  it("returns kind: 'suppress-recommended' on a violation whose suggestion mentions ra11y-disable", () => {
    const match = findHeadingHierarchyViolation();
    const payload = buildSuggestFixPayload({
      ruleId: match.ruleId,
      line: match.location.line,
      match,
      sourceContext: file.source,
      source: file.source,
      filePath: file.filePath,
    });
    expect(payload["kind"]).toBe("suppress-recommended");
  });

  it("ships the canonical pragma scoped to the violation's first criterion", () => {
    const match = findHeadingHierarchyViolation();
    const payload = buildSuggestFixPayload({
      ruleId: match.ruleId,
      line: match.location.line,
      match,
      sourceContext: file.source,
      source: file.source,
      filePath: file.filePath,
    });
    // .html → HTML-comment pragma form. The criterion ID rides as
    // a sibling so an agent triaging the response doesn't have to
    // re-derive the suppression scope from prose.
    const firstCriterion = match.criteria[0];
    expect(typeof firstCriterion).toBe("string");
    expect(payload["pragma"]).toBe(`<!-- ra11y-disable ${firstCriterion} -->`);
    expect(payload["criterionId"]).toBe(firstCriterion);
  });

  it("does NOT ship a newText (or fixPaths.edit) — there is no edit to apply", () => {
    const match = findHeadingHierarchyViolation();
    const payload = buildSuggestFixPayload({
      ruleId: match.ruleId,
      line: match.location.line,
      match,
      sourceContext: file.source,
      source: file.source,
      filePath: file.filePath,
    });
    // The shape mirrors `kind: "guidance"` minus the implicit edit
    // promise. `newText` and a top-level `fixPaths.edit.newText`
    // would advertise a mechanical edit the response cannot honor.
    expect(payload).not.toHaveProperty("newText");
    expect(payload["primary"]).not.toHaveProperty("newText");
  });

  it("preserves the rule's prose verbatim under primary.explanation", () => {
    const match = findHeadingHierarchyViolation();
    const payload = buildSuggestFixPayload({
      ruleId: match.ruleId,
      line: match.location.line,
      match,
      sourceContext: file.source,
      source: file.source,
      filePath: file.filePath,
    });
    const primary = payload["primary"] as { explanation: string };
    expect(typeof primary.explanation).toBe("string");
    // The sentinel token that drove the partition still rides in the
    // explanation prose so the agent can verify the reason for the
    // discriminator at a glance.
    expect(primary.explanation).toContain("ra11y-disable");
  });
});
