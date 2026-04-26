import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/layout/horizontal-scroll-no-keyboard.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule layout/horizontal-scroll-no-keyboard", () => {
  describe("fires when", () => {
    it("a rule declares overflow-x: auto", () => {
      const violations = runRule(rule, `.table-wrapper { overflow-x: auto; }`, {
        filePath: "style.css",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("layout/horizontal-scroll-no-keyboard");
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.message).toContain(".table-wrapper");
      expect(violations[0]?.message).toContain("overflow-x");
      expect(violations[0]?.message).toContain("auto");
    });

    it("a rule declares overflow-x: scroll", () => {
      const violations = runRule(rule, `.scroller { overflow-x: scroll; }`, {
        filePath: "style.css",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("scroll");
    });

    it("a rule declares overflow: auto (shorthand)", () => {
      const violations = runRule(rule, `.box { overflow: auto; }`, {
        filePath: "style.css",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("overflow");
      expect(violations[0]?.message).toContain("auto");
    });

    it("a rule declares overflow: scroll (shorthand)", () => {
      const violations = runRule(rule, `.code { overflow: scroll; }`, {
        filePath: "style.css",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("scroll");
    });

    it("a :is(...) compound selector with overflow-x: scroll fires once", () => {
      const violations = runRule(rule, `:is(.box1, .box2) { overflow-x: scroll; }`, {
        filePath: "style.css",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(":is(.box1, .box2)");
    });

    it("the two-value overflow shorthand with auto on the x axis fires", () => {
      // `overflow: scroll hidden` sets overflow-x: scroll, overflow-y: hidden.
      const violations = runRule(rule, `.row { overflow: scroll hidden; }`, {
        filePath: "style.css",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("scroll");
    });

    it("a rule inside a @media block still fires", () => {
      const violations = runRule(
        rule,
        `@media (max-width: 600px) {
          .responsive-table { overflow-x: auto; }
        }`,
        { filePath: "style.css" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(".responsive-table");
    });
  });

  describe("does not fire when", () => {
    it("overflow is hidden", () => {
      const violations = runRule(rule, `.box { overflow: hidden; }`, {
        filePath: "style.css",
      });
      expect(violations).toHaveLength(0);
    });

    it("overflow is visible", () => {
      const violations = runRule(rule, `.box { overflow: visible; }`, {
        filePath: "style.css",
      });
      expect(violations).toHaveLength(0);
    });

    it("overflow-x is hidden", () => {
      const violations = runRule(rule, `.box { overflow-x: hidden; }`, {
        filePath: "style.css",
      });
      expect(violations).toHaveLength(0);
    });

    it("only overflow-y is auto (vertical-only does not fail 2.1.1 horizontally)", () => {
      // SC 2.1.1 covers vertical scrolling too via wheel/keystroke fallback,
      // but this rule is scoped to the horizontal-scroll wrapper case where
      // arrow keys cannot reach off-axis content without focus on the wrapper.
      const violations = runRule(rule, `.column { overflow-y: auto; }`, {
        filePath: "style.css",
      });
      expect(violations).toHaveLength(0);
    });

    it("an unrelated property is set", () => {
      const violations = runRule(rule, `.box { color: red; padding: 1rem; }`, {
        filePath: "style.css",
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("emits one violation per CSS rule even when both overflow-x and overflow are declared", () => {
      // Authors sometimes write both for robustness; the candidate is the
      // wrapper, not the declaration count.
      const violations = runRule(
        rule,
        `.wrapper {
          overflow: auto;
          overflow-x: scroll;
        }`,
        { filePath: "style.css" },
      );
      expect(violations).toHaveLength(1);
    });

    it("suggestion names the rendered fix on the matching element, not the stylesheet", () => {
      const violations = runRule(rule, `.table-wrapper { overflow-x: auto; }`, {
        filePath: "style.css",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain('tabindex="0"');
      expect(violations[0]?.suggestion).toContain("aria-label");
      expect(violations[0]?.suggestion).toContain(".table-wrapper");
    });

    it("scss input routes through the css AST and fires the same way", () => {
      const violations = runRule(rule, `.wrapper { overflow-x: auto; }`, {
        filePath: "style.scss",
      });
      expect(violations).toHaveLength(1);
    });
  });

  describe("rule metadata", () => {
    it("declares wcag22:2.1.1 and wcag21:2.1.1", () => {
      expect(rule.satisfies).toContain("wcag22:2.1.1");
      expect(rule.satisfies).toContain("wcag21:2.1.1");
    });

    it("is document-scoped and severity=warning", () => {
      expect(rule.scope).toBe("document");
      expect(rule.severity).toBe("warning");
    });

    it("has a normativeQuote citing WCAG 2.1.1 Keyboard", () => {
      expect(rule.docs.normativeQuote).toBeDefined();
      expect(rule.docs.normativeQuote).toContain("keyboard");
    });
  });
});
