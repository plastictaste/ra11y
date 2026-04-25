import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/navigation/href-javascript-scheme.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule navigation/href-javascript-scheme", () => {
  describe("HTML: fires on javascript: scheme variants", () => {
    it('href="javascript:void(0)" (canonical form)', () => {
      const violations = runRule(rule, `<a href="javascript:void(0)">Click</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/href-javascript-scheme");
      expect(violations[0]?.severity).toBe("error");
      expect(violations[0]?.criteria).toContain("wcag22:4.1.2");
      expect(violations[0]?.criteria).toContain("wcag22:2.1.1");
    });

    it('href="javascript:void 0" (no parens, legal JS)', () => {
      const violations = runRule(rule, `<a href="javascript:void 0">Click</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it('href="javascript: void(0)" (whitespace after colon)', () => {
      const violations = runRule(rule, `<a href="javascript: void(0)">Click</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it('href="javascript:;" (empty statement)', () => {
      const violations = runRule(rule, `<a href="javascript:;">Click</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it('href="javascript:" (scheme with empty body)', () => {
      const violations = runRule(rule, `<a href="javascript:">Click</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it('href="javascript" (no colon — typo shape)', () => {
      const violations = runRule(rule, `<a href="javascript">Click</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it('href="JAVASCRIPT:void(0)" (case-insensitive scheme)', () => {
      // RFC 3986 §3.1 makes URL schemes case-insensitive; browsers
      // honor that. Our detection must match.
      const violations = runRule(rule, `<a href="JAVASCRIPT:void(0)">Click</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it('href="javascript:alert(1)" (arbitrary expression, still non-navigating)', () => {
      const violations = runRule(rule, `<a href="javascript:alert(1)">Hi</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });
  });

  describe("HTML: does not fire on non-scheme placeholders or real URLs", () => {
    it('href="#" — handled by navigation/href-empty-fragment', () => {
      const violations = runRule(rule, `<a href="#">Click</a>`, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });

    it('href="" — handled by navigation/href-empty-fragment', () => {
      const violations = runRule(rule, `<a href="">Forgot password?</a>`, {
        filePath: "signin.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("real URL path", () => {
      const violations = runRule(rule, `<a href="/dashboard">Dashboard</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("https:// URL", () => {
      const violations = runRule(rule, `<a href="https://example.com">Example</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("fragment to an in-page id", () => {
      const violations = runRule(rule, `<a href="#section-2">Section 2</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("mailto: URL", () => {
      const violations = runRule(rule, `<a href="mailto:hi@example.com">Email</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("tel: URL", () => {
      const violations = runRule(rule, `<a href="tel:+15551234">Call</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("bare <a> with no href attribute (not this rule's concern)", () => {
      const violations = runRule(rule, `<a>plain text</a>`, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires on javascript: scheme variants", () => {
    it('href="javascript:void(0)"', () => {
      const violations = runRule(rule, `const X = <a href="javascript:void(0)">Click</a>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/href-javascript-scheme");
    });

    it('href="javascript:;"', () => {
      const violations = runRule(rule, `const X = <a href="javascript:;">Click</a>;`);
      expect(violations).toHaveLength(1);
    });
  });

  describe("JSX: does not fire", () => {
    it("real URL", () => {
      const violations = runRule(rule, `const X = <a href="/x">Go</a>;`);
      expect(violations).toHaveLength(0);
    });

    it("expression-form href={url} (opaque — agent investigates if suspicious)", () => {
      // Static analysis can't resolve the expression; the AI-first
      // consumer model says "surface deterministic evidence, don't
      // guess." We stay silent.
      const violations = runRule(rule, `const X = <a href={url}>Go</a>;`);
      expect(violations).toHaveLength(0);
    });

    it("PascalCase Link component is not a bare <a>", () => {
      const violations = runRule(rule, `const X = <Link href="javascript:void(0)">Go</Link>;`);
      expect(violations).toHaveLength(0);
    });
  });

  describe("context-aware fix suggestion", () => {
    it('javascript: scheme → suggests <button type="button">', () => {
      const violations = runRule(rule, `<a href="javascript:void(0)">x</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      const sugg = violations[0]?.suggestion ?? "";
      expect(sugg).toContain(`<button type="button"`);
      expect(sugg).toContain("javascript:void(0)");
    });

    it("message echoes the offending href literal", () => {
      const violations = runRule(rule, `<a href="javascript:alert(1)">x</a>`, {
        filePath: "index.html",
      });
      expect(violations[0]?.message).toContain("javascript:alert(1)");
    });
  });

  describe("edge cases", () => {
    it("multiple offending anchors fire once each", () => {
      const violations = runRule(
        rule,
        `<a href="javascript:void(0)">A</a><a href="javascript:;">B</a><a href="/real">C</a>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(2);
    });
  });

  describe("rule metadata", () => {
    it("declares wcag22:4.1.2 + wcag22:2.1.1 and the 2.1 equivalents", () => {
      expect(rule.satisfies).toContain("wcag22:4.1.2");
      expect(rule.satisfies).toContain("wcag22:2.1.1");
      expect(rule.satisfies).toContain("wcag21:4.1.2");
      expect(rule.satisfies).toContain("wcag21:2.1.1");
    });
  });
});
