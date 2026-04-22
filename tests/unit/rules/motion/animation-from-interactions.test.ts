import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/motion/animation-from-interactions.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule motion/animation-from-interactions", () => {
  describe("CSS: fires when selector is user-interaction-gated and", () => {
    it(":hover has a transition declaration", () => {
      const v = runRule(rule, `.btn:hover { transition: transform 0.2s; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain("user-interaction pseudo-class");
      expect(v[0]?.message).toContain("transition");
      expect(v[0]?.suggestion).toContain("prefers-reduced-motion");
    });

    it(":focus has an animation declaration", () => {
      const v = runRule(rule, `.input:focus { animation: pulse 0.6s; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain(".input:focus");
    });

    it(":active has a transition-duration", () => {
      const v = runRule(rule, `.card:active { transition-duration: 150ms; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(1);
    });

    it(":focus-visible has an animation", () => {
      const v = runRule(rule, `.link:focus-visible { animation: glow 0.4s; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(1);
    });

    it(":focus-within has a transition", () => {
      const v = runRule(rule, `.panel:focus-within { transition: background 0.2s; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(1);
    });

    it("every comma-separated part contains a user-interaction pseudo-class", () => {
      const v = runRule(rule, `.a:hover, .b:focus { transition: opacity 0.2s; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(1);
    });
  });

  describe("CSS: does NOT fire when", () => {
    it("selector has no user-interaction pseudo-class", () => {
      const v = runRule(rule, `.spinner { animation: spin 1s infinite; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
    });

    it("selector is a mixed list (one part not gated)", () => {
      // `.btn` alone animates without interaction — routes to 2.2.2, not 2.3.3.
      const v = runRule(rule, `.btn, .btn:hover { transition: transform 0.2s; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
    });

    it(":hover rule is wrapped in prefers-reduced-motion", () => {
      const src = `@media (prefers-reduced-motion: reduce) { .btn:hover { transition: none; } }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });

    it("universal reduced-motion override is present", () => {
      const src = [
        `.btn:hover { transition: transform 0.2s; }`,
        `@media (prefers-reduced-motion: reduce) {`,
        `  *, *::before, *::after {`,
        `    animation-duration: 0.01ms !important;`,
        `    transition-duration: 0.01ms !important;`,
        `  }`,
        `}`,
      ].join("\n");
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });

    it("animation value is none on a :hover selector", () => {
      const v = runRule(rule, `.btn:hover { transition: none; }`, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });

    it(":hover selector has no animation/transition properties", () => {
      const v = runRule(rule, `.btn:hover { color: red; background: blue; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
    });

    it(":target selector is NOT treated as user-interaction (navigation, not hover/focus)", () => {
      const v = runRule(rule, `.section:target { transition: background 0.3s; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
    });
  });

  describe("HTML <style> blocks", () => {
    it(":hover transition inside a <style> block fires", () => {
      const src = [
        `<!doctype html><html><head>`,
        `<style>`,
        `  .btn:hover { transition: transform 0.2s; }`,
        `</style>`,
        `</head><body></body></html>`,
      ].join("\n");
      const v = runRule(rule, src, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("user-interaction pseudo-class");
    });

    it("line number points into the HTML file, not the extracted CSS", () => {
      const src = [
        `<!doctype html><html><head>`, // line 1
        `<style>`, // line 2
        `  .btn:hover { transition: transform 0.2s; }`, // line 3
        `</style>`, // line 4
        `</head></html>`, // line 5
      ].join("\n");
      const v = runRule(rule, src, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.location.line).toBe(3);
    });

    it("<style> block with prefers-reduced-motion guard does not fire", () => {
      const src = [
        `<!doctype html><html><head>`,
        `<style>`,
        `  @media (prefers-reduced-motion: reduce) {`,
        `    .btn:hover { transition: none; }`,
        `  }`,
        `</style>`,
        `</head></html>`,
      ].join("\n");
      const v = runRule(rule, src, { filePath: "index.html" });
      expect(v).toHaveLength(0);
    });
  });

  describe("spec-lane discrimination (does NOT fire on 2.2.2 surfaces)", () => {
    it("<marquee> is 2.2.2-only — this rule ignores it", () => {
      const v = runRule(rule, `<marquee>News</marquee>`, { filePath: "index.html" });
      expect(v).toHaveLength(0);
    });

    it("data-bs-ride='carousel' is 2.2.2-only — this rule ignores it", () => {
      const v = runRule(rule, `<div data-bs-ride="carousel"></div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("inline style= transition on an element is 2.2.2-only — this rule ignores it", () => {
      const v = runRule(rule, `<div style="transition-duration: 2s"></div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("bare selector (no pseudo-class) does not fire here — it's 2.2.2's job", () => {
      const v = runRule(rule, `.spinner { animation: spin 1s infinite; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("only cites wcag22:2.3.3 and wcag21:2.3.3 (single-lane)", () => {
      expect(rule.satisfies).toContain("wcag22:2.3.3");
      expect(rule.satisfies).toContain("wcag21:2.3.3");
      expect(rule.satisfies).not.toContain("wcag22:2.2.2");
    });

    it("suggestion preserves the original selector (hover feedback should remain visible)", () => {
      const v = runRule(rule, `.btn:hover { transition: transform 0.2s; }`, {
        filePath: "styles.css",
      });
      expect(v[0]?.suggestion).toContain(".btn:hover");
      expect(v[0]?.suggestion).toContain("hover/focus remain visually distinct");
    });

    it(":focus identifier boundary — matches :focus-visible as a pseudo-class (treated as interaction-gated)", () => {
      // Sanity: :focus-visible is itself a user-interaction pseudo-class, not
      // a spurious substring match of :focus. Verify the rule handles it.
      const v = runRule(rule, `.link:focus-visible { animation: fade 0.3s; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(1);
    });

    it("descendant combinator with :hover in the middle fires", () => {
      const v = runRule(rule, `.nav .item:hover .icon { transition: opacity 0.2s; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(1);
    });

    it("selector with an at-symbol identifier containing `hover-card` (substring) does not fire", () => {
      // Name contains `hover` but not `:hover`. The pseudo-class check must
      // only match the actual pseudo-class token, not arbitrary substrings.
      const v = runRule(rule, `.hover-card { animation: pulse 1s; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
    });
  });
});
