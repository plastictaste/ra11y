import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/document/iframe-title.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule document/iframe-title", () => {
  describe("HTML: fires a violation when", () => {
    it("iframe has no title at all", () => {
      const violations = runRule(rule, `<iframe src="/video"></iframe>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("document/iframe-title");
      expect(violations[0]?.severity).toBe("error");
      expect(violations[0]?.criteria).toContain("wcag22:4.1.2");
      expect(violations[0]?.criteria).toContain("wcag22:2.4.1");
    });

    it("iframe has an empty title attribute", () => {
      const violations = runRule(rule, `<iframe src="/video" title=""></iframe>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("iframe has a whitespace-only title", () => {
      const violations = runRule(rule, `<iframe src="/video" title="   "></iframe>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("iframe has a whitespace-only aria-label", () => {
      const violations = runRule(rule, `<iframe src="/video" aria-label="  "></iframe>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("multiple unlabelled iframes each fire once", () => {
      const src = `<div><iframe src="/a"></iframe><iframe src="/b"></iframe></div>`;
      const violations = runRule(rule, src, { filePath: "index.html" });
      expect(violations).toHaveLength(2);
    });
  });

  describe("HTML: does not fire when", () => {
    it("iframe has a meaningful title", () => {
      const violations = runRule(
        rule,
        `<iframe src="/video" title="Product demo video"></iframe>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("iframe has aria-label in place of title", () => {
      const violations = runRule(
        rule,
        `<iframe src="/signup" aria-label="Sign-up form"></iframe>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("iframe has aria-labelledby in place of title", () => {
      const violations = runRule(
        rule,
        `<h2 id="frame-heading">Tutorial</h2><iframe src="/tut" aria-labelledby="frame-heading"></iframe>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("iframe is aria-hidden='true' (exempt)", () => {
      const violations = runRule(rule, `<iframe src="/ad" aria-hidden="true"></iframe>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires a violation when", () => {
    it("iframe has no title prop", () => {
      const violations = runRule(rule, `const X = <iframe src="/video" />;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("document/iframe-title");
    });

    it("iframe has an empty-string title", () => {
      const violations = runRule(rule, `const X = <iframe src="/video" title="" />;`);
      expect(violations).toHaveLength(1);
    });

    it("iframe has a whitespace-only title", () => {
      const violations = runRule(rule, `const X = <iframe src="/video" title="   " />;`);
      expect(violations).toHaveLength(1);
    });
  });

  describe("JSX: does not fire when", () => {
    it("iframe has a string title", () => {
      const violations = runRule(rule, `const X = <iframe src="/x" title="Demo video" />;`);
      expect(violations).toHaveLength(0);
    });

    it("iframe has an expression-valued title (runtime-computed)", () => {
      const violations = runRule(rule, `const X = <iframe src="/x" title={label} />;`);
      expect(violations).toHaveLength(0);
    });

    it("iframe has aria-label substitute", () => {
      const violations = runRule(rule, `const X = <iframe src="/x" aria-label="Sign-up form" />;`);
      expect(violations).toHaveLength(0);
    });

    it("iframe has aria-labelledby substitute", () => {
      const violations = runRule(rule, `const X = <iframe src="/x" aria-labelledby="hdr" />;`);
      expect(violations).toHaveLength(0);
    });

    it("iframe is aria-hidden='true' (exempt)", () => {
      const violations = runRule(rule, `const X = <iframe src="/x" aria-hidden="true" />;`);
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("ignores non-iframe elements", () => {
      const violations = runRule(rule, `<div><p>no frames here</p></div>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("suggestion is context-aware (mentions src URL)", () => {
      const violations = runRule(rule, `<iframe src="/product-demo"></iframe>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("/product-demo");
      expect(violations[0]?.suggestion).toContain("Product demo");
    });

    it("suggestion handles iframes without a src", () => {
      const violations = runRule(rule, `<iframe></iframe>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("title");
    });
  });

  describe("generic-title detection", () => {
    it("flags title='YouTube video' (HTML)", () => {
      const violations = runRule(
        rule,
        `<iframe src="https://youtube.com/embed/abc" title="YouTube video"></iframe>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("generic");
      expect(violations[0]?.message).toContain("YouTube video");
      expect(violations[0]?.suggestion).toContain("content-specific");
    });

    it("flags title='iframe' (HTML)", () => {
      const violations = runRule(rule, `<iframe src="/x" title="iframe"></iframe>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("generic");
    });

    it("flags title='Embedded Content' case-insensitively (HTML)", () => {
      const violations = runRule(rule, `<iframe src="/x" title="Embedded Content"></iframe>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("flags title='  Vimeo video  ' after trim/collapse (HTML)", () => {
      const violations = runRule(rule, `<iframe src="/x" title="  Vimeo   video  "></iframe>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("flags generic aria-label (HTML)", () => {
      const violations = runRule(rule, `<iframe src="/x" aria-label="untitled"></iframe>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("aria-label");
    });

    it("flags title='YouTube video' in JSX", () => {
      const violations = runRule(rule, `const X = <iframe src="/x" title="YouTube video" />;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("generic");
    });

    it("does NOT flag title with generic word as substring", () => {
      // Whole-string match only — "YouTube tutorial..." is informative.
      const violations = runRule(
        rule,
        `<iframe src="/x" title="YouTube tutorial on ARIA live regions"></iframe>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("does NOT flag a descriptive title containing 'video'", () => {
      const violations = runRule(rule, `<iframe src="/x" title="Product demo video"></iframe>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("generic-title violation still satisfies 4.1.2", () => {
      const violations = runRule(rule, `<iframe src="/x" title="YouTube video"></iframe>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.criteria).toContain("wcag22:4.1.2");
    });
  });

  // Belt-and-braces gate (Q7-HTML-SHAPE-RULES-GATE-NON-JSX-JS): the
  // `appliesTo.fileExtensions` check upstream aliases `.js → .jsx` so
  // Next.js-style JSX-in-`.js` corpora keep scanning, but minified
  // bundles and packed plugins parse JSX-shaped substrings out of
  // string templates that are not real DOM elements. The rule must
  // not act on JSX nodes surfaced from a bare `.js` / `.ts` file.
  describe("non-JSX JS gate", () => {
    it("does not fire on a bare .js file containing an iframe-shaped substring", () => {
      const source = `var html = '<iframe src="/embed"></iframe>';`;
      const violations = runRule(rule, source, { filePath: "vendor.js" });
      expect(violations).toHaveLength(0);
    });

    it("does not fire on a bare .ts file containing an iframe-shaped substring", () => {
      const source = `const tpl = \`<iframe src="/embed"></iframe>\`;`;
      const violations = runRule(rule, source, { filePath: "build.ts" });
      expect(violations).toHaveLength(0);
    });

    it("still fires on a .tsx file containing the same iframe element", () => {
      const violations = runRule(rule, `function F(){return <iframe src="/embed"/>}`, {
        filePath: "Frame.tsx",
      });
      expect(violations).toHaveLength(1);
    });
  });

  describe("rule metadata", () => {
    it("declares wcag22 and wcag21 for 4.1.2 and 2.4.1", () => {
      expect(rule.satisfies).toContain("wcag22:4.1.2");
      expect(rule.satisfies).toContain("wcag21:4.1.2");
      expect(rule.satisfies).toContain("wcag22:2.4.1");
      expect(rule.satisfies).toContain("wcag21:2.4.1");
    });

    it("has a normativeQuote citing WCAG", () => {
      expect(rule.docs.normativeQuote).toBeDefined();
      expect(rule.docs.references[0]).toContain("WCAG22");
    });
  });
});
