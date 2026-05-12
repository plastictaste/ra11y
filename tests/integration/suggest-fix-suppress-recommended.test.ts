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
  // The `semantics/heading-hierarchy` rule's `reportMissingH1` emit
  // (the partial-shape / no-full-page branch) opens with prose that
  // does NOT lead with a positive-edit verb — "A document without an
  // <h1> loses the single top-of-document landmark AT relies on;
  // verify… If this page is a fragment or layout intentionally
  // rendered inside a parent with its own <h1>, suppress with
  // <!-- ra11y-disable wcag22:1.3.1 -->." That's the canonical
  // conceded-N/A shape the discriminator partitions away from
  // generic `kind: "guidance"`: the rule's evidence model can't
  // honestly establish whether the page owns the document envelope,
  // so the dismissal path is the source-level disable.
  const file: FileSpec = {
    filePath: "/page.html",
    // Body shape: one non-h1 heading and no landmark / list /
    // body-level script. Fails every `looksLikeFullPage` branch, so
    // `fullPageMissingH1` stays false and the rule routes through
    // `reportMissingH1` (the partial-shape branch) — the canonical
    // conceded-N/A suggestion.
    source: '<!doctype html><html lang="en"><body><h2>section</h2></body></html>',
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

describe("suggest_fix: kind discriminator does NOT route positive-edit suggestions to suppress-recommended", () => {
  // Doctrine — `docs/kb/architecture/ai-first-consumer.md`
  // "Suppress-recommended is a distinct discriminator from guidance":
  // the predicate must require BOTH (a) the prose names the pragma
  // token AND (b) the primary sentence does NOT lead with a
  // positive-edit verb. Rules whose suggestion text leads with an
  // imperative edit ("Add aria-haspopup…", "Insert an <h1>…",
  // "Drop the redundant role") but trails with a pragma fallback
  // ("If this control is not actually a dropdown trigger, suppress
  // with…") must stay on their declared lane — the primary advice
  // is the edit, not the dismissal. The historical loose predicate
  // mis-routed these suggestions to `kind: "suppress-recommended"`
  // and made the per-class plan tally lie about the per-call shape.

  // `semantics/heading-hierarchy` `reportMissingH1OnFullPage` —
  // body has ≥3 visible descendants with no headings → page-shape
  // routes through the empty-structural-shell branch and the rule
  // emits "Insert an <h1> at the top of <body>… If this page is
  // rendered inside a parent layout that supplies the title,
  // suppress with <!-- ra11y-disable wcag22:1.3.1 -->." First
  // sentence leads with "Insert" → positive edit verb → must NOT
  // be suppress-recommended.
  it("`heading-hierarchy` 'Insert an <h1>…' (with pragma fallback) routes to guidance, not suppress-recommended", () => {
    const fileSpec: FileSpec = {
      filePath: "/page.html",
      source:
        '<!doctype html><html lang="en"><body><div>one</div><div>two</div><div>three</div></body></html>',
    };
    const built = { filePath: fileSpec.filePath, ...parseFile(fileSpec) };
    const { result } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: [built],
    });
    const match = result.violations.find(
      (v) => v.ruleId === "semantics/heading-hierarchy" && /^Insert /.test(v.suggestion ?? ""),
    );
    if (!match) {
      throw new Error("expected a heading-hierarchy violation with 'Insert an <h1>…' suggestion");
    }
    expect(match.suggestion).toContain("ra11y-disable");
    expect(match.suggestion).toMatch(/^Insert /);
    const payload = buildSuggestFixPayload({
      ruleId: match.ruleId,
      line: match.location.line,
      match: match as Violation,
      sourceContext: fileSpec.source,
      source: fileSpec.source,
      filePath: fileSpec.filePath,
    });
    expect(payload["kind"]).not.toBe("suppress-recommended");
  });

  // `aria/dropdown-toggle-triple-aria-missing` — Bootstrap-style
  // toggle missing aria-haspopup + aria-controls. Suggestion leads
  // with "Add aria-haspopup=\"menu\" and aria-controls=\"<menu-id>\""
  // and trails with "If this control is not actually a dropdown
  // trigger, suppress with <!-- ra11y-disable
  // aria/dropdown-toggle-triple-aria-missing -->". The primary
  // advice IS a real attribute edit; only the fallback names the
  // pragma. Must NOT route to suppress-recommended.
  it("`aria/dropdown-toggle-triple-aria-missing` 'Add aria-haspopup…' routes to guidance lane, not suppress-recommended", () => {
    const fileSpec: FileSpec = {
      filePath: "/toggle.html",
      source: '<button data-toggle="dropdown">Menu</button>',
    };
    const built = { filePath: fileSpec.filePath, ...parseFile(fileSpec) };
    const { result } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: [built],
    });
    const match = result.violations.find(
      (v) => v.ruleId === "aria/dropdown-toggle-triple-aria-missing",
    );
    if (!match) throw new Error("expected an aria/dropdown-toggle-triple-aria-missing violation");
    // Sanity: rule's suggestion really does carry both a leading
    // positive-edit verb AND a pragma fallback.
    expect(match.suggestion).toMatch(/^Add /);
    expect(match.suggestion).toContain("ra11y-disable");
    const payload = buildSuggestFixPayload({
      ruleId: match.ruleId,
      line: match.location.line,
      match: match as Violation,
      sourceContext: fileSpec.source,
      source: fileSpec.source,
      filePath: fileSpec.filePath,
    });
    expect(payload["kind"]).not.toBe("suppress-recommended");
  });
});
