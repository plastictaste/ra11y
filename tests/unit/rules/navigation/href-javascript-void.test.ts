import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/navigation/href-javascript-void.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule navigation/href-javascript-void", () => {
  describe("HTML: fires on javascript: scheme variants", () => {
    it('href="javascript:void(0)" (canonical form)', () => {
      const violations = runRule(rule, `<a href="javascript:void(0)">Click</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/href-javascript-void");
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

  describe("HTML: fires on bare fragment #", () => {
    it('href="#" (bare placeholder)', () => {
      const violations = runRule(rule, `<a href="#">Click</a>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/href-javascript-void");
    });

    it('href="  #  " (whitespace trimmed before comparison)', () => {
      const violations = runRule(rule, `<a href="  #  ">Click</a>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
    });
  });

  describe("HTML: fires on empty href", () => {
    // Per HTML spec, an empty href resolves to the current document URL —
    // activating the link reloads the page rather than navigating. The
    // anchor still announces as a link, so the role/behavior contradict
    // the same way `href="#"` does. `link-no-href` only catches the
    // empty-href case when an onClick is also present (its scope is the
    // <a onClick> keyboard-trap pattern); the bare-text case below is
    // common in legacy form pages ("Forgot password?", social-share
    // rows wired up later) and was previously silent in both rules.

    it('href="" (empty placeholder, no onClick — Forgot password? pattern)', () => {
      const violations = runRule(rule, `<a href="">Forgot password?</a>`, {
        filePath: "signin.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/href-javascript-void");
      expect(violations[0]?.severity).toBe("error");
      expect(violations[0]?.criteria).toContain("wcag22:4.1.2");
    });

    it('href="   " (whitespace-only collapses to empty after trim)', () => {
      const violations = runRule(rule, `<a href="   ">Click</a>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/href-javascript-void");
    });
  });

  describe("HTML: does not fire on navigating hrefs", () => {
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
      // A bare anchor without href is inert; link-no-href handles the
      // click-handler variant. This rule only classifies existing href
      // values, so it stays silent.
      const violations = runRule(rule, `<a>plain text</a>`, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires on javascript: scheme variants", () => {
    it('href="javascript:void(0)"', () => {
      const violations = runRule(rule, `const X = <a href="javascript:void(0)">Click</a>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/href-javascript-void");
    });

    it('href="javascript:;"', () => {
      const violations = runRule(rule, `const X = <a href="javascript:;">Click</a>;`);
      expect(violations).toHaveLength(1);
    });
  });

  describe("JSX: fires on bare fragment", () => {
    it('href="#"', () => {
      const violations = runRule(rule, `const X = <a href="#">Click</a>;`);
      expect(violations).toHaveLength(1);
    });
  });

  describe("JSX: fires on empty href", () => {
    it('href="" (empty placeholder, no onClick)', () => {
      const violations = runRule(rule, `const X = <a href="">Forgot password?</a>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/href-javascript-void");
    });
  });

  describe("JSX: does not fire", () => {
    it("real URL", () => {
      const violations = runRule(rule, `const X = <a href="/x">Go</a>;`);
      expect(violations).toHaveLength(0);
    });

    it("fragment to a named id", () => {
      const violations = runRule(rule, `const X = <a href="#top">Top</a>;`);
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

    it('bare # → suggests <button type="button"> or a real fragment id', () => {
      const violations = runRule(rule, `<a href="#">x</a>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      const sugg = violations[0]?.suggestion ?? "";
      expect(sugg).toContain(`<button type="button"`);
      expect(sugg).toContain("section-id");
    });

    it("empty href → message names page-reload behavior; suggestion offers real path or <button>", () => {
      const violations = runRule(rule, `<a href="">Forgot password?</a>`, {
        filePath: "signin.html",
      });
      expect(violations).toHaveLength(1);
      const message = violations[0]?.message ?? "";
      const sugg = violations[0]?.suggestion ?? "";
      expect(message).toContain("reloads");
      expect(sugg).toContain('href="/real/path"');
      expect(sugg).toContain(`<button type="button"`);
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
        `<a href="javascript:void(0)">A</a><a href="#">B</a><a href="">C</a><a href="/real">D</a>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(3);
    });

    it('fragment-nav case `<a href="#non-empty-id">` still does NOT fire', () => {
      // Regression guard — extending coverage to empty href must not
      // sweep up legitimate in-page fragment navigation. Real fragment
      // ids land on a node and scroll/focus it; that's real navigation.
      const violations = runRule(rule, `<a href="#non-empty-id">Skip to main</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
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
