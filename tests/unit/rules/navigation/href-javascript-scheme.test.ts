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

  // Belt-and-braces DOM-origin gate: a `javascript:` href substring
  // inside a packed plugin or minified `.js` bundle is not a real anchor
  // — the surrounding code may be a string-template factory, a JS-API
  // wrapper, or a build-time interpolation. Only act on JSX nodes parsed
  // out of `.tsx` / `.jsx` (and the JSX-bearing `.mdx` / `.astro`
  // aliases).
  describe("non-JSX JS gate", () => {
    it("does not fire on a bare .js file containing an anchor-shaped substring", () => {
      const source = `var html = '<a href="javascript:void(0)">click</a>';`;
      const violations = runRule(rule, source, { filePath: "vendor.js" });
      expect(violations).toHaveLength(0);
    });

    it("does not fire on a bare .ts file containing an anchor-shaped substring", () => {
      const source = `const tpl = \`<a href="javascript:;">x</a>\`;`;
      const violations = runRule(rule, source, { filePath: "build.ts" });
      expect(violations).toHaveLength(0);
    });

    it("still fires on a .tsx file containing the same anchor element", () => {
      const violations = runRule(rule, `function F(){return <a href="javascript:void(0)">x</a>}`, {
        filePath: "Link.tsx",
      });
      expect(violations).toHaveLength(1);
    });
  });

  // When the flagged anchor sits inside a docs-example wrapper, the rule
  // appends a one-read dismissal hint to message + suggestion so the agent
  // can recognize demonstration code in one pass. Reason-enrichment only —
  // emission and severity stay unchanged.
  describe("docs-example ancestor hint", () => {
    it("JSX: anchor inside <Example> ancestor adds the component hint", () => {
      const violations = runRule(
        rule,
        `function F(){return <Example><a href="javascript:void(0)">x</a></Example>}`,
        { filePath: "Page.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.severity).toBe("error");
      expect(violations[0]?.message).toContain("<Example> component");
      expect(violations[0]?.suggestion).toContain("<Example> component");
    });

    it("JSX: anchor inside nested <CodeBlock> ancestor adds the component hint", () => {
      const violations = runRule(
        rule,
        `function F(){return <CodeBlock><div><a href="javascript:;">x</a></div></CodeBlock>}`,
        { filePath: "Page.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("<CodeBlock> component");
    });

    it("HTML: anchor inside <pre><code> adds the <pre> block hint", () => {
      // The walk surfaces the closest matching ancestor first; <code> is
      // matched before <pre> in DOM-traversal order, but the ancestor walk
      // goes child→parent, so <code> wins. Either tag is a valid hint —
      // assert on the substring "block" to keep the test robust to either.
      const violations = runRule(
        rule,
        `<pre><code><a href="javascript:void(0)">x</a></code></pre>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("block");
      // Specifically — the hint should name <code> as the closest ancestor.
      expect(violations[0]?.message).toContain("<code> block");
    });

    it("HTML: anchor inside class-tagged wrapper adds the class-name hint", () => {
      const violations = runRule(
        rule,
        `<div class="docs-example"><a href="javascript:void(0)">x</a></div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("example");
    });

    it("HTML: anchor outside any docs-example wrapper has no hint appended", () => {
      const violations = runRule(rule, `<div><a href="javascript:void(0)">x</a></div>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).not.toContain("demonstration code");
      expect(violations[0]?.suggestion).not.toContain("demonstration code");
    });

    it("JSX: existing emission is preserved when no example ancestor exists", () => {
      // Regression guard — without a docs-example ancestor the message is
      // unchanged from the pre-hint shape.
      const violations = runRule(rule, `const X = <a href="javascript:void(0)">x</a>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.severity).toBe("error");
      expect(violations[0]?.message).not.toContain("demonstration code");
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
