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

    it("the selector targets a <textarea> (intrinsically focusable, textbook reset CSS)", () => {
      // Reset stylesheets routinely set `textarea { overflow: auto }` to
      // normalize UA quirks. <textarea> is intrinsically focusable, so
      // the rule's recommended fix (add tabindex / aria-label) would be
      // a false positive on every reset stylesheet ever shipped.
      const violations = runRule(rule, `textarea { overflow: auto; }`, {
        filePath: "reset.css",
      });
      expect(violations).toHaveLength(0);
    });

    it("the selector targets <input>, <select>, <button>, <iframe>", () => {
      for (const tag of ["input", "select", "button", "iframe"]) {
        const violations = runRule(rule, `${tag} { overflow-x: auto; }`, { filePath: "reset.css" });
        expect(violations).toHaveLength(0);
      }
    });

    it("the selector targets a[href] (focusable when href is present)", () => {
      const violations = runRule(rule, `a[href] { overflow-x: auto; }`, {
        filePath: "style.css",
      });
      expect(violations).toHaveLength(0);
    });

    it("the selector targets audio[controls] / video[controls]", () => {
      for (const tag of ["audio[controls]", "video[controls]"]) {
        const violations = runRule(rule, `${tag} { overflow: auto; }`, { filePath: "style.css" });
        expect(violations).toHaveLength(0);
      }
    });

    it("the selector carries an explicit [tabindex] attribute", () => {
      const violations = runRule(rule, `[tabindex="0"] { overflow-x: auto; }`, {
        filePath: "style.css",
      });
      expect(violations).toHaveLength(0);
    });

    it("the rightmost compound is a focusable element with a class chain", () => {
      // `textarea.fancy` / `textarea:hover` — the leading type selector
      // pins the subject as <textarea>; class / pseudo-class refinements
      // do not change focusability.
      for (const sel of ["textarea.fancy", "textarea:hover", "textarea[name='bio']"]) {
        const violations = runRule(rule, `${sel} { overflow: auto; }`, {
          filePath: "style.css",
        });
        expect(violations).toHaveLength(0);
      }
    });

    it("a descendant selector whose subject is focusable", () => {
      // `.form textarea` — descendant combinator, but the subject is
      // still <textarea>. Same reset pattern, scoped to a form.
      const violations = runRule(rule, `.form textarea { overflow: auto; }`, {
        filePath: "style.css",
      });
      expect(violations).toHaveLength(0);
    });

    it("every comma-branch is a focusable element", () => {
      // Reset patterns that lump form controls together.
      const violations = runRule(rule, `textarea, input, select { overflow: auto; }`, {
        filePath: "reset.css",
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

    it("a mixed comma list (focusable + non-focusable) still fires", () => {
      // The non-focusable branch (.card) is the candidate the agent must
      // verify. Suppressing on "one branch is focusable" would silently
      // hide the .card finding — a silent miss.
      const violations = runRule(rule, `textarea, .card { overflow-x: auto; }`, {
        filePath: "style.css",
      });
      expect(violations).toHaveLength(1);
    });

    it("a bare <a> (no href) still fires — anchor without href is not focusable", () => {
      // `<a>` is only focusable when it has an `href` attribute. A CSS
      // rule that targets bare `a` matches both `<a href>` and `<a>`
      // (named-target / placeholder) — only the former is focusable, so
      // we keep the candidate live and let the agent verify.
      const violations = runRule(rule, `a { overflow-x: auto; }`, {
        filePath: "style.css",
      });
      expect(violations).toHaveLength(1);
    });

    it("a descendant selector whose subject is non-focusable (.foo > .bar) still fires", () => {
      // The subject is .bar (a class), even though .foo could in
      // principle target a focusable type. Conservative: if the rightmost
      // compound is non-focusable, emit.
      const violations = runRule(rule, `textarea > .bar { overflow: auto; }`, {
        filePath: "style.css",
      });
      expect(violations).toHaveLength(1);
    });

    it(":is(...) wrapping the rightmost compound conservatively still fires", () => {
      // Without recursing into the parens we cannot prove every inner
      // branch is focusable. Per the asymmetry rule, surface and let
      // the agent triage rather than silently suppress.
      const violations = runRule(rule, `:is(textarea, .card) { overflow-x: auto; }`, {
        filePath: "style.css",
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
