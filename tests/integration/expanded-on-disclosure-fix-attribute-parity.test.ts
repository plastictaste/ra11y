/**
 * Integration test: per-finding parity between the
 * `aria/expanded-on-disclosure` rule's emitted message and the
 * suggest_fix payload's explanation — same attribute named on both
 * channels.
 *
 * Doctrine source: `docs/kb/architecture/ai-first-consumer.md` —
 * "Reason / priority / fix-description must agree across all three
 * channels." When the rule's message names a missing attribute (e.g.
 * "missing aria-expanded"), the suggested fix must add THAT attribute,
 * not a different one. A message-vs-fix attribute mismatch is the
 * canonical contradiction the doctrine forbids: the agent reads the
 * message to identify the gap, then reads the fix to close it; the
 * two answering different questions either wastes a `suggest_fix`
 * round-trip or — worse — leads the agent to apply the wrong
 * attribute and ship a finding that re-fires on the next scan.
 *
 * The rule has two finding kinds:
 *   - `missing-expanded` — element has no `aria-expanded` at all; fix
 *     must add `aria-expanded`.
 *   - `missing-controls` — element carries `aria-expanded` but no
 *     `aria-controls`, and the disclosure shape was proven by a
 *     non-`aria-controls` branch (data-*-toggle, onclick classList,
 *     disclosure-class token); fix must add `aria-controls`.
 *
 * We exercise both finding kinds across HTML and JSX surfaces and
 * across every disclosure-evidence branch, then drive
 * `buildSuggestFixPayload` directly (mirroring what the suggest_fix
 * MCP handler does) to confirm the per-call explanation cites the
 * same attribute the rule's message named.
 */

import { describe, expect, it } from "bun:test";

import { runScan } from "../../src/engine/scanner.ts";
import { parseHtml } from "../../src/input/parsers/html.ts";
import { parseTsx } from "../../src/input/parsers/index.ts";
import { buildSuggestFixPayload } from "../../src/mcp/tool-suggest-fix-internals.ts";
import { BUILTIN_RULES } from "../../src/rules/index.ts";
import { BUILTIN_STANDARDS } from "../../src/standards/index.ts";
import type { Ast } from "../../src/types/ast.ts";

interface Sample {
  readonly label: string;
  readonly filePath: string;
  readonly source: string;
  readonly language: "html" | "tsx";
  /**
   * The attribute the rule's message and the suggest_fix explanation
   * must both name. Either `aria-expanded` (when the element lacks
   * the state attribute outright) or `aria-controls` (when the element
   * has `aria-expanded` but the disclosure shape was proven by a
   * non-`aria-controls` evidence branch).
   */
  readonly expectedAttribute: "aria-expanded" | "aria-controls";
}

function parseFile(sample: Sample): { source: string; ast: Ast } {
  if (sample.language === "html") {
    const parsed = parseHtml(sample.source);
    return {
      source: sample.source,
      ast: { language: "html", root: parsed.root, errors: parsed.errors },
    };
  }
  const parsed = parseTsx(sample.source);
  return {
    source: sample.source,
    ast: { language: "tsx", root: parsed.root, errors: parsed.errors },
  };
}

const SAMPLES: readonly Sample[] = [
  // ---- missing-expanded branch (no aria-expanded at all) ----
  {
    label: "HTML aria-controls branch — element has no aria-expanded",
    filePath: "/aria-controls.html",
    language: "html",
    source: `<!doctype html><html><body>
  <button aria-controls="panel-1">Details</button>
  <div id="panel-1" hidden>secret</div>
</body></html>`,
    expectedAttribute: "aria-expanded",
  },
  {
    label: "HTML data-bs-toggle branch — element has no aria-expanded",
    filePath: "/data-toggle.html",
    language: "html",
    source: `<!doctype html><html><body>
  <a href="#c1" data-bs-toggle="collapse">Toggle</a>
</body></html>`,
    expectedAttribute: "aria-expanded",
  },
  {
    label: "HTML onclick-classlist branch — element has no aria-expanded",
    filePath: "/onclick.html",
    language: "html",
    source: `<!doctype html><html><body>
  <button onclick="document.getElementById('p').classList.toggle('collapse')">Toggle</button>
</body></html>`,
    expectedAttribute: "aria-expanded",
  },
  {
    label: "HTML disclosure-class branch — element has no aria-expanded",
    filePath: "/class-token.html",
    language: "html",
    source: `<!doctype html><html><body>
  <button class="dropdown-toggle">Menu</button>
</body></html>`,
    expectedAttribute: "aria-expanded",
  },
  {
    label: "JSX aria-controls branch — element has no aria-expanded",
    filePath: "/Panel.tsx",
    language: "tsx",
    source: `function Panel() {
  return (
    <>
      <button aria-controls="p1">Details</button>
      <div id="p1" hidden>secret</div>
    </>
  );
}`,
    expectedAttribute: "aria-expanded",
  },
  {
    label: "JSX disclosure-class branch — element has no aria-expanded",
    filePath: "/Toggle.tsx",
    language: "tsx",
    source: `function Toggle() {
  return <button className="dropdown-toggle">Menu</button>;
}`,
    expectedAttribute: "aria-expanded",
  },
  // ---- missing-controls branch (aria-expanded present, no aria-controls) ----
  {
    label: "HTML data-toggle branch — aria-expanded present, no aria-controls",
    filePath: "/bs-dropdown.html",
    language: "html",
    source: `<!doctype html><html><body>
  <button data-bs-toggle="dropdown" aria-expanded="false">Menu</button>
</body></html>`,
    expectedAttribute: "aria-controls",
  },
  {
    label: "HTML disclosure-class branch — aria-expanded present, no aria-controls",
    filePath: "/dropdown-toggle-class.html",
    language: "html",
    source: `<!doctype html><html><body>
  <button class="dropdown-toggle" aria-expanded="false">Menu</button>
</body></html>`,
    expectedAttribute: "aria-controls",
  },
  {
    label: "JSX data-toggle branch — aria-expanded present, no aria-controls",
    filePath: "/Dropdown.tsx",
    language: "tsx",
    source: `function Dropdown() {
  return <button data-bs-toggle="dropdown" aria-expanded="false">Menu</button>;
}`,
    expectedAttribute: "aria-controls",
  },
];

/**
 * Read the suggest_fix payload's explanation prose (the field the
 * agent actually reads to compose the edit). The
 * `aria/expanded-on-disclosure` rule does not emit `fixPaths`, so
 * suggest_fix routes through the prose-only fallback that mirrors
 * the rule's declared `fixClass` lane (`verify-in-source`) under
 * "Per-call shape must agree with per-class plan tally."
 *
 * Accepts `guidance`, `verify-in-source`, and `suppress-recommended`
 * — the rule's suggestion leads with `"Add aria-controls=…"` or
 * `"Add aria-expanded=…"` (positive-edit verbs), so the tightened
 * suppress-recommended predicate routes these emissions onto their
 * declared lane (`verify-in-source`) rather than to
 * `suppress-recommended` despite the trailing pragma fallback. We
 * still accept the legacy `"guidance"` kind in case the lane
 * declaration shifts. All three shapes nest the explanation
 * identically, so the attribute-parity invariant the suite pins is
 * unaffected.
 */
function explanationFromGuidance(payload: Record<string, unknown>): string {
  const kind = payload.kind;
  expect(
    kind === "guidance" || kind === "verify-in-source" || kind === "suppress-recommended",
  ).toBe(true);
  const primary = payload.primary as Record<string, unknown> | undefined;
  expect(primary).toBeDefined();
  const explanation = primary?.explanation;
  expect(typeof explanation).toBe("string");
  return explanation as string;
}

describe("aria/expanded-on-disclosure: rule message and suggest_fix explanation name the same attribute", () => {
  for (const sample of SAMPLES) {
    it(sample.label, () => {
      const { ast } = parseFile(sample);
      const { result } = runScan({
        standards: BUILTIN_STANDARDS,
        rules: BUILTIN_RULES,
        enabled: ["wcag22"],
        files: [{ filePath: sample.filePath, source: sample.source, ast }],
      });
      const violations = result.violations.filter(
        (v) => v.ruleId === "aria/expanded-on-disclosure",
      );
      expect(violations).toHaveLength(1);
      const violation = violations[0];
      if (!violation) throw new Error("expected one disclosure-rule violation");

      // The rule's emitted message must name the attribute the
      // expected branch claims is missing — and must NOT name the
      // other attribute (the contradiction this test forbids).
      const otherAttribute =
        sample.expectedAttribute === "aria-expanded" ? "aria-controls" : "aria-expanded";
      expect(violation.message).toContain(sample.expectedAttribute);
      expect(violation.suggestion).toContain(sample.expectedAttribute);
      // The "other" attribute may legitimately appear in surrounding
      // prose (e.g. "the disclosure trigger has aria-expanded but is
      // missing aria-controls" mentions both). We pin the load-bearing
      // invariant: when the rule's message says X is missing, the
      // suggestion must instruct adding X — never instruct adding the
      // other attribute as the primary action.
      const addOther = new RegExp(`Add ${otherAttribute}\\b`);
      expect(violation.suggestion).not.toMatch(addOther);
      const addExpected = new RegExp(`Add ${sample.expectedAttribute}\\b`);
      expect(violation.suggestion).toMatch(addExpected);

      // Drive suggest_fix the same way the MCP handler does: pass the
      // matched violation through buildSuggestFixPayload and assert
      // the per-call explanation names the same attribute.
      const payload = buildSuggestFixPayload({
        ruleId: violation.ruleId,
        line: violation.location.line,
        match: violation,
        sourceContext: "",
        source: sample.source,
        filePath: sample.filePath,
      });
      const explanation = explanationFromGuidance(payload);
      expect(explanation).toMatch(addExpected);
      expect(explanation).not.toMatch(addOther);
    });
  }
});
