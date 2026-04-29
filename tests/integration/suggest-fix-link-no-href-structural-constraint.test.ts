/**
 * Integration test: `suggest_fix` on a `navigation/link-no-href` finding
 * inside a structural-ancestor constraint (`<ul role="menu">`,
 * `<ul class="dropdown-menu">`, `<select>`, `<table>` etc.) does NOT
 * propose an unconstrained `<a>` → `<button>` swap. The suggestion text
 * must (a) name the constraint and (b) propose the within-constraint
 * alternative.
 *
 * Doctrine: docs/kb/architecture/ai-first-consumer.md
 *   - "Reason / priority / fix-description must agree across all three
 *     channels" — the fix.description channel must not contradict the
 *     surrounding evidence (here: the ancestor's keyboard / content
 *     model).
 *   - "Per-call shape must agree with per-class plan tally" — when the
 *     per-rule advice is "swap <a> for <button>" but the per-call
 *     evidence is "you can't, the parent's role contract forbids it,"
 *     the silent-miss is the agent applying the swap and breaking the
 *     menu's keyboard model.
 *
 * The rule itself is the suggestion-text emitter; suggest_fix forwards
 * `match.suggestion` verbatim. This test pins that flow end-to-end so a
 * future refactor of suggest_fix's payload assembly cannot silently
 * drop the constraint context.
 */

import { describe, expect, it } from "bun:test";

import { runScan } from "../../src/engine/scanner.ts";
import { parseHtml } from "../../src/input/parsers/html.ts";
import { parseTsx } from "../../src/input/parsers/index.ts";
import { buildSuggestFixPayload } from "../../src/mcp/tool-suggest-fix-internals.ts";
import { BUILTIN_RULES } from "../../src/rules/index.ts";
import { BUILTIN_STANDARDS } from "../../src/standards/index.ts";
import type { Ast } from "../../src/types/ast.ts";

interface FileSpec {
  readonly filePath: string;
  readonly source: string;
  readonly lang: "html" | "tsx";
}

function parseFor(spec: FileSpec): { source: string; ast: Ast } {
  if (spec.lang === "html") {
    const p = parseHtml(spec.source);
    return { source: spec.source, ast: { language: "html", root: p.root, errors: p.errors } };
  }
  const p = parseTsx(spec.source);
  return { source: spec.source, ast: { language: spec.lang, root: p.root, errors: p.errors } };
}

function payloadDescriptionFor(spec: FileSpec): string {
  const { ast } = parseFor(spec);
  const { result } = runScan({
    standards: BUILTIN_STANDARDS,
    rules: BUILTIN_RULES,
    enabled: ["wcag22"],
    files: [{ filePath: spec.filePath, source: spec.source, ast }],
  });
  const match = result.violations.find((v) => v.ruleId === "navigation/link-no-href");
  expect(match).toBeDefined();
  if (!match) return "";
  const payload = buildSuggestFixPayload({
    ruleId: "navigation/link-no-href",
    line: match.location.line,
    match,
    sourceContext: spec.source,
    source: spec.source,
    filePath: spec.filePath,
    sameFileFindings: result.violations,
  });
  // The suggestion text rides through `primary.explanation` on the
  // guidance lane (the lane navigation/link-no-href takes — it has no
  // mechanical fixPaths). See tool-suggest-fix-routing.ts.
  const primary = (payload as { primary?: { explanation?: string } }).primary;
  return primary?.explanation ?? "";
}

describe("suggest_fix on navigation/link-no-href inside a structural-ancestor constraint", () => {
  it('HTML: <a onclick> inside <ul role="menu"> — description names the menu constraint, not a bare <a>→<button> swap', () => {
    const description = payloadDescriptionFor({
      filePath: "/menu.html",
      lang: "html",
      source: `<ul role="menu">
  <li><a onclick="doThing()">Action</a></li>
</ul>
`,
    });
    expect(description.length).toBeGreaterThan(0);
    expect(description).toContain(`role="menu"`);
    expect(description).toContain("menuitem");
    // The "HOWEVER" clause is the explicit signal that the bare swap is
    // not the right fix here.
    expect(description).toContain("HOWEVER");
  });

  it('HTML: <a onclick> inside <ul class="dropdown-menu"> — description names the Bootstrap dropdown constraint', () => {
    const description = payloadDescriptionFor({
      filePath: "/dropdown.html",
      lang: "html",
      source: `<ul class="dropdown-menu">
  <li><a onclick="doThing()">Action</a></li>
</ul>
`,
    });
    expect(description.length).toBeGreaterThan(0);
    expect(description).toContain("dropdown-menu");
    expect(description.toLowerCase()).toContain("keyboard model");
  });

  it("HTML: <a onclick> inside table ladder — description names the table content-model constraint", () => {
    const description = payloadDescriptionFor({
      filePath: "/table.html",
      lang: "html",
      source: `<table><tbody><tr><td><a onclick="edit()">Edit</a></td></tr></tbody></table>
`,
    });
    expect(description.length).toBeGreaterThan(0);
    expect(description).toContain("table-structural");
  });

  it('JSX: <a onClick> inside <ul role="menu"> — description names the menu constraint', () => {
    const description = payloadDescriptionFor({
      filePath: "/Menu.tsx",
      lang: "tsx",
      source: `export const Menu = () => (
  <ul role="menu">
    <li><a onClick={doThing}>Action</a></li>
  </ul>
);
`,
    });
    expect(description.length).toBeGreaterThan(0);
    expect(description).toContain(`role="menu"`);
    expect(description).toContain("menuitem");
  });

  it("HTML: <a onclick> with no constrained ancestor — description does NOT carry the HOWEVER constraint clause", () => {
    // Negative-control: a bare <a onclick> in a <div> retains the
    // original suggestion shape; the constraint logic must not falsely
    // fire.
    const description = payloadDescriptionFor({
      filePath: "/plain.html",
      lang: "html",
      source: `<div><a onclick="doThing()">Click</a></div>
`,
    });
    expect(description.length).toBeGreaterThan(0);
    expect(description).not.toContain("HOWEVER");
  });
});
