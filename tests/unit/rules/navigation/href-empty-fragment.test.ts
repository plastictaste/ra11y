import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/navigation/href-empty-fragment.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule navigation/href-empty-fragment", () => {
  describe("HTML: fires on bare fragment #", () => {
    it('href="#" (bare placeholder)', () => {
      const violations = runRule(rule, `<a href="#">Click</a>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/href-empty-fragment");
      expect(violations[0]?.severity).toBe("error");
      expect(violations[0]?.criteria).toContain("wcag22:4.1.2");
      expect(violations[0]?.criteria).toContain("wcag22:2.1.1");
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
      expect(violations[0]?.ruleId).toBe("navigation/href-empty-fragment");
      expect(violations[0]?.severity).toBe("error");
      expect(violations[0]?.criteria).toContain("wcag22:4.1.2");
    });

    it('href="   " (whitespace-only collapses to empty after trim)', () => {
      const violations = runRule(rule, `<a href="   ">Click</a>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/href-empty-fragment");
    });
  });

  describe("HTML: does not fire on javascript: schemes or real URLs", () => {
    it('href="javascript:void(0)" — handled by navigation/href-javascript-scheme', () => {
      const violations = runRule(rule, `<a href="javascript:void(0)">Click</a>`, {
        filePath: "index.html",
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

    it("bare <a> with no href attribute (not this rule's concern)", () => {
      const violations = runRule(rule, `<a>plain text</a>`, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires on bare fragment", () => {
    it('href="#"', () => {
      const violations = runRule(rule, `const X = <a href="#">Click</a>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/href-empty-fragment");
    });
  });

  describe("JSX: fires on empty href", () => {
    it('href="" (empty placeholder, no onClick)', () => {
      const violations = runRule(rule, `const X = <a href="">Forgot password?</a>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/href-empty-fragment");
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
      const violations = runRule(rule, `const X = <a href={url}>Go</a>;`);
      expect(violations).toHaveLength(0);
    });

    it("PascalCase Link component is not a bare <a>", () => {
      const violations = runRule(rule, `const X = <Link href="#">Go</Link>;`);
      expect(violations).toHaveLength(0);
    });
  });

  describe("context-aware fix suggestion", () => {
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
  });

  describe("edge cases", () => {
    it("multiple offending anchors fire once each", () => {
      const violations = runRule(rule, `<a href="#">A</a><a href="">B</a><a href="/real">C</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(2);
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

  // Belt-and-braces gate (Q7-HTML-SHAPE-RULES-GATE-NON-JSX-JS): an
  // `<a href="">` substring inside a packed plugin or minified `.js`
  // bundle is not a real anchor — the surrounding code may be a
  // string-template factory, a JS-API wrapper, or a build-time
  // interpolation. Only act on JSX nodes parsed out of `.tsx` / `.jsx`
  // (and the JSX-bearing `.mdx` / `.astro` aliases).
  describe("non-JSX JS gate", () => {
    it("does not fire on a bare .js file containing a placeholder anchor substring", () => {
      const source = `var html = '<a href="">click</a>';`;
      const violations = runRule(rule, source, { filePath: "vendor.js" });
      expect(violations).toHaveLength(0);
    });

    it("does not fire on a bare .ts file containing a bare-fragment anchor substring", () => {
      const source = `const tpl = \`<a href="#">x</a>\`;`;
      const violations = runRule(rule, source, { filePath: "build.ts" });
      expect(violations).toHaveLength(0);
    });

    it("still fires on a .tsx file containing the same placeholder anchor", () => {
      const violations = runRule(rule, `function F(){return <a href="">x</a>}`, {
        filePath: "Link.tsx",
      });
      expect(violations).toHaveLength(1);
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
