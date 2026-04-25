import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/semantics/visual-disabled-non-control.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule semantics/visual-disabled-non-control", () => {
  describe("HTML: fires a violation when", () => {
    it("a <div class='disabled'> has no aria-disabled and no interactive role", () => {
      const source = `<div class="card disabled">Coming soon</div>`;
      const violations = runRule(rule, source, { filePath: "card.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("semantics/visual-disabled-non-control");
      expect(violations[0]?.criteria).toContain("wcag22:4.1.2");
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.message).toMatch(/disabled/);
      expect(violations[0]?.suggestion).toMatch(/aria-disabled="true"/);
    });

    it("a <span class='inactive'> has no programmatic disabled signal", () => {
      const source = `<span class="inactive">Filter unavailable</span>`;
      const violations = runRule(rule, source, { filePath: "filter.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/inactive/);
    });

    it("a <li class='is-disabled'> in a menu list", () => {
      const source = `<ul>
  <li>Active</li>
  <li class="is-disabled">Archived</li>
</ul>`;
      const violations = runRule(rule, source, { filePath: "menu.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/is-disabled/);
    });

    it("an <a> without href and class='disabled-state' fires", () => {
      const source = `<a class="next disabled-state">Next &rsaquo;</a>`;
      const violations = runRule(rule, source, { filePath: "pager.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/disabled-state/);
    });

    it("a <div> with inline style 'cursor: not-allowed' fires", () => {
      const source = `<div style="cursor: not-allowed; opacity: 0.5;">Locked</div>`;
      const violations = runRule(rule, source, { filePath: "locked.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/cursor: not-allowed/);
    });

    it("a <span> with inline style 'pointer-events: none' fires", () => {
      const source = `<span style="pointer-events:none;">Cannot edit</span>`;
      const violations = runRule(rule, source, { filePath: "view.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/pointer-events: none/);
    });
  });

  describe("HTML: does not fire when", () => {
    it("the element carries aria-disabled='true'", () => {
      const source = `<div class="disabled" aria-disabled="true" role="button" tabindex="-1">Coming soon</div>`;
      const violations = runRule(rule, source, { filePath: "card.html" });
      expect(violations).toHaveLength(0);
    });

    it("the element is a real <button class='disabled' disabled> control", () => {
      // <button> is outside the non-interactive-host gate; the
      // disabled attribute is the right signal here and this rule
      // doesn't claim the case.
      const source = `<button class="disabled" disabled>Submit</button>`;
      const violations = runRule(rule, source, { filePath: "form.html" });
      expect(violations).toHaveLength(0);
    });

    it("an <a class='disabled'> with href is a focusable anchor (out of scope)", () => {
      const source = `<a class="disabled" href="/cancel">Cancel</a>`;
      const violations = runRule(rule, source, { filePath: "actions.html" });
      expect(violations).toHaveLength(0);
    });

    it("the element has an interactive role (passes; covered by role-specific rules)", () => {
      const source = `<div class="disabled" role="checkbox">Toggle</div>`;
      const violations = runRule(rule, source, { filePath: "form.html" });
      expect(violations).toHaveLength(0);
    });

    it("opacity: 0.5 alone is not a visual-disabled signal (deliberately not matched)", () => {
      const source = `<div class="card" style="opacity: 0.5;">Faded card</div>`;
      const violations = runRule(rule, source, { filePath: "card.html" });
      expect(violations).toHaveLength(0);
    });

    it("a class with an unrelated word does not match", () => {
      const source = `<div class="card-disabled-tomorrow">Card</div>`;
      // "card-disabled-tomorrow" is one token, not the word "disabled"
      const violations = runRule(rule, source, { filePath: "card.html" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires a violation when", () => {
    it("<div className='disabled'> has no aria-disabled", () => {
      const source = `export function Card() {
  return <div className="card disabled">Coming soon</div>;
}`;
      const violations = runRule(rule, source, { filePath: "Card.tsx" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/aria-disabled="true"/);
    });

    it("<span className='inactive'> with no role fires", () => {
      const source = `export function Filter() {
  return <span className="inactive">Filter unavailable</span>;
}`;
      const violations = runRule(rule, source, { filePath: "Filter.tsx" });
      expect(violations).toHaveLength(1);
    });

    it("<div style='cursor: not-allowed'> with a string-literal style attribute fires", () => {
      // String-literal style passes through getJsxAttributeString; the
      // object-expression form `style={{ ... }}` is intentionally opaque.
      const source = `export function Locked() {
  return <div style="cursor: not-allowed">Locked</div>;
}`;
      const violations = runRule(rule, source, { filePath: "Locked.tsx" });
      expect(violations).toHaveLength(1);
    });
  });

  describe("JSX: does not fire when", () => {
    it("the element has aria-disabled='true'", () => {
      const source = `export function Card() {
  return <div className="disabled" aria-disabled="true" role="button" tabIndex={-1}>Coming soon</div>;
}`;
      const violations = runRule(rule, source, { filePath: "Card.tsx" });
      expect(violations).toHaveLength(0);
    });

    it("the tag is a PascalCase component (opaque — may render anything)", () => {
      const source = `export function Wrapper() {
  return <Card className="disabled">Coming soon</Card>;
}`;
      const violations = runRule(rule, source, { filePath: "Wrapper.tsx" });
      expect(violations).toHaveLength(0);
    });

    it("style is an object-expression (opaque to the static parser)", () => {
      // The rule deliberately doesn't peek into `style={{ ... }}` —
      // parsing the object-expression to read its values is the kind
      // of heuristic the AI-first doctrine pushes back on.
      const source = `export function Locked() {
  return <div style={{ cursor: "not-allowed" }}>Locked</div>;
}`;
      const violations = runRule(rule, source, { filePath: "Locked.tsx" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("case-insensitive class token matching — 'Is-Disabled' still trips", () => {
      const source = `<div class="Is-Disabled">Greyed</div>`;
      const violations = runRule(rule, source, { filePath: "card.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/Is-Disabled/);
    });

    it("class with extra whitespace and newlines is tokenized correctly", () => {
      const source = `<div class="  card    inactive   ">Item</div>`;
      const violations = runRule(rule, source, { filePath: "card.html" });
      expect(violations).toHaveLength(1);
    });

    it("'cursor:not-allowed' with no whitespace between property and value matches", () => {
      const source = `<div style="cursor:not-allowed">Locked</div>`;
      const violations = runRule(rule, source, { filePath: "view.html" });
      expect(violations).toHaveLength(1);
    });
  });

  describe("rule metadata", () => {
    it("declares wcag22:4.1.2 and wcag21:4.1.2 in satisfies", () => {
      expect(rule.satisfies).toContain("wcag22:4.1.2");
      expect(rule.satisfies).toContain("wcag21:4.1.2");
    });

    it("severity is warning (predicate strength does not assert violation)", () => {
      expect(rule.severity).toBe("warning");
    });

    it("normativeQuote cites the Name, Role, Value SC", () => {
      expect(rule.docs.normativeQuote).toMatch(/programmatically determined/);
      expect(rule.docs.references[0]).toMatch(/WCAG22/);
    });
  });
});
