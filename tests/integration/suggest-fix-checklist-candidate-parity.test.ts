/**
 * Integration test: every checklist candidate's `(criterionId, file,
 * line)` tuple must resolve to a non-`none` `suggest_fix` outcome on
 * the same input.
 *
 * Doctrine: docs/kb/architecture/ai-first-consumer.md "Per-call shape
 * must agree with per-class plan tally" extended one level deeper to
 * "checklist candidate → suggest_fix lane parity." Manual-review
 * checklist items ship `candidates[]` populated by candidate finders,
 * which are intentionally broader than the single rule that satisfies
 * the criterion ("Surface, don't suppress" — finders emit
 * low-confidence candidates the rule's narrower predicate skips). When
 * an agent picks a checklist candidate's `(file, line)` and calls
 * `suggest_fix(<rule-or-criterion>, file, line)`, the rule lookup
 * misses on every low-confidence candidate; pre-closure the response
 * shipped `kind: "none"` with no breadcrumb, dead-ending the agent on
 * a candidate the same project response had advertised.
 *
 * Canonical fixture: `<select onchange="setLang(this.value)">` is the
 * decorative-handler shape the `forms/select-onchange-context-change`
 * rule does NOT fire on (no nav/submit token in the handler), but the
 * `review/on-input-change` finder DOES surface for `wcag22:3.2.2`
 * review at low confidence ("body not inline; verify no conditional
 * context change"). The closure routes `suggest_fix` through the
 * candidate-bridge so the response carries `kind: "guidance"` with the
 * candidate's `reason` as the primary explanation.
 */

import { describe, expect, it } from "bun:test";

import { runScan } from "../../src/engine/scanner.ts";
import { parseHtml } from "../../src/input/parsers/html.ts";
import { findCandidateAtLine } from "../../src/mcp/suggest-fix-candidate-bridge.ts";
import { buildSuggestFixPayload } from "../../src/mcp/tool-suggest-fix-internals.ts";
import { BUILTIN_CANDIDATE_FINDERS } from "../../src/review/index.ts";
import { BUILTIN_RULES } from "../../src/rules/index.ts";
import { BUILTIN_STANDARDS } from "../../src/standards/index.ts";

describe("suggest_fix lookup must agree with checklist candidate emission", () => {
  it("resolves to kind: 'guidance' on a low-confidence candidate the rule's narrower predicate skips", () => {
    const filePath = "_includes/header.html";
    // Decorative onchange — `setLang` is a state-update callback, not
    // a navigation token. Rule `forms/select-onchange-context-change`
    // does NOT fire (no `location.`, `window.open`, `submit()`, etc.
    // in the handler text). Finder `review/on-input-change` surfaces
    // the candidate at low confidence per "Surface, don't suppress."
    const source = `<form>
  <select onchange="setLang(this.value)">
    <option value="en">English</option>
    <option value="fr">Français</option>
  </select>
</form>
`;
    const parsedHtml = parseHtml(source);
    const ast = {
      language: "html" as const,
      root: parsedHtml.root,
      errors: parsedHtml.errors,
    };
    const parsed = {
      filePath,
      source,
      ast,
      disableMap: new Map<number, ReadonlySet<string>>(),
    };

    // Rule scan must NOT emit on this fixture — the silence here is
    // what forces `suggest_fix` into the no-match branch the
    // candidate-bridge closes.
    const { result } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: [{ filePath, source, ast }],
    });
    const ruleViolation = result.violations.find(
      (v) => v.ruleId === "forms/select-onchange-context-change",
    );
    expect(ruleViolation).toBeUndefined();

    // Candidate-bridge lookup against the checklist's emission path —
    // same finder runner the main scanner uses.
    const candidate = findCandidateAtLine({
      parsed,
      finders: BUILTIN_CANDIDATE_FINDERS,
      criteria: ["wcag22:3.2.2"],
      enabledStandards: new Set(["wcag22"]),
      line: 2,
    });
    expect(candidate).not.toBeNull();
    expect(candidate?.criterionId).toBe("wcag22:3.2.2");
    expect(candidate?.location.line).toBe(2);

    // Build the payload the way the handler does — match undefined,
    // candidateMatch threaded in. The closure routes to `kind:
    // "guidance"` rather than the dead-end `kind: "none"`.
    const payload = buildSuggestFixPayload({
      ruleId: "forms/select-onchange-context-change",
      line: 2,
      match: undefined,
      sourceContext: source,
      source,
      filePath,
      sameFileFindings: result.violations,
      ...(candidate === null ? {} : { candidateMatch: candidate }),
    });
    expect(payload["kind"]).toBe("guidance");
    const primary = payload["primary"] as Record<string, unknown> | undefined;
    expect(primary).toBeDefined();
    // The candidate's reason becomes the primary explanation — agents
    // following a checklist row see actionable guidance rather than
    // "no violation found."
    expect(primary?.["explanation"]).toContain("onchange");
    expect(primary?.["confidence"]).toBe("low");
  });

  it("falls through to kind: 'none' when no finder candidate matches the line", () => {
    const filePath = "test.html";
    const source = `<!doctype html><html><body>
<p>just text</p>
</body></html>
`;
    const parsedHtml = parseHtml(source);
    const ast = {
      language: "html" as const,
      root: parsedHtml.root,
      errors: parsedHtml.errors,
    };
    const parsed = {
      filePath,
      source,
      ast,
      disableMap: new Map<number, ReadonlySet<string>>(),
    };
    const candidate = findCandidateAtLine({
      parsed,
      finders: BUILTIN_CANDIDATE_FINDERS,
      criteria: ["wcag22:3.2.2"],
      enabledStandards: new Set(["wcag22"]),
      line: 2,
    });
    expect(candidate).toBeNull();
    const payload = buildSuggestFixPayload({
      ruleId: "forms/select-onchange-context-change",
      line: 2,
      match: undefined,
      sourceContext: source,
      source,
      filePath,
      sameFileFindings: [],
    });
    expect(payload["kind"]).toBe("none");
  });
});
