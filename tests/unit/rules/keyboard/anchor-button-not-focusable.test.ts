import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/keyboard/anchor-button-not-focusable.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule keyboard/anchor-button-not-focusable", () => {
  describe("fires a violation when", () => {
    it("HTML <a> has role='button' with no href and no tabindex", () => {
      const violations = runRule(rule, `<a role="button">Open dialog</a>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("keyboard/anchor-button-not-focusable");
      expect(violations[0]?.message).toMatch(/role="button"/);
      expect(violations[0]?.suggestion).toMatch(/<button type="button">/);
    });

    it("HTML <a> has bare 'btn' class with no href and no tabindex", () => {
      const violations = runRule(rule, `<a class="btn">Click me</a>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/class token "btn"/);
    });

    it("HTML <a> has 'btn-primary' BEM-style class and no href", () => {
      const violations = runRule(rule, `<a class="btn-primary lg">Save</a>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/class token "btn-primary"/);
    });

    it("JSX <a> has role='button' with no href and no tabIndex", () => {
      const violations = runRule(rule, `const X = () => <a role="button">Open</a>;`, {
        filePath: "input.tsx",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/<button type="button">/);
    });

    it("JSX <a> uses className with 'button' token and no href", () => {
      const violations = runRule(
        rule,
        `const X = () => <a className="button button_lg">Submit</a>;`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/class token "button"/);
    });

    it("HTML <a> has tabindex='-1' (not in tab order)", () => {
      const violations = runRule(rule, `<a class="btn" tabindex="-1">Hidden</a>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(1);
    });
  });

  describe("does not fire when", () => {
    it("<a> has href (any value, including '#')", () => {
      const violations = runRule(rule, `<a class="btn" href="#">Click me</a>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("<a> has tabindex='0'", () => {
      const violations = runRule(rule, `<a role="button" tabindex="0">Open</a>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("<a> has no role and no btn/button class (plain anchor)", () => {
      const violations = runRule(rule, `<a class="link">Read more</a>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("<a> has href and a btn class", () => {
      const violations = runRule(rule, `<a class="btn btn-primary" href="/orders">Orders</a>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("<a> has a class containing 'btn' as a substring without separator", () => {
      // `btnGroup` / `buttonbar` are utility-class names that don't promise
      // button semantics on the host element; only `btn`/`button` tokens
      // (bare or `-`/`_`-prefixed) match.
      const violations = runRule(rule, `<a class="btnGroup">Wrapper</a>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("<button> with the same shape is not flagged (rule only targets <a>)", () => {
      const violations = runRule(rule, `<button class="btn">Click me</button>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("JSX <a> has tabIndex={0} via string-literal value", () => {
      const violations = runRule(rule, `const X = () => <a role="button" tabIndex="0">Open</a>;`, {
        filePath: "input.tsx",
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("positive tabindex like '5' counts as focusable", () => {
      const violations = runRule(rule, `<a role="button" tabindex="5">Open</a>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("tabindex with whitespace is normalized", () => {
      const violations = runRule(rule, `<a role="button" tabindex=" 0 ">Open</a>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("non-numeric tabindex value is treated as non-focusable", () => {
      const violations = runRule(rule, `<a role="button" tabindex="auto">Open</a>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("role='BUTTON' (uppercase) still matches case-insensitively", () => {
      const violations = runRule(rule, `<a role="BUTTON">Open</a>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(1);
    });
  });
});
