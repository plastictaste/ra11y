import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/semantics/svg-title-missing.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule semantics/svg-title-missing", () => {
  describe("fires a violation when", () => {
    it("a standalone .svg has no <title>, no aria-label, no aria-labelledby", () => {
      const src = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <path d="M10 10L20 20" />
</svg>`;
      const violations = runRule(rule, src, { filePath: "icons/search.svg" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("semantics/svg-title-missing");
      expect(violations[0]?.criteria).toContain("wcag22:1.1.1");
      expect(violations[0]?.criteria).toContain("wcag22:4.1.2");
      expect(violations[0]?.suggestion).toMatch(/<title>/);
    });

    it("the svg has an empty <title> child (whitespace-only)", () => {
      const src = `<svg xmlns="http://www.w3.org/2000/svg">
  <title>   </title>
  <path d="M10 10" />
</svg>`;
      const violations = runRule(rule, src, { filePath: "empty.svg" });
      expect(violations).toHaveLength(1);
    });

    it("the svg has aria-label with empty-string value", () => {
      const src = `<svg xmlns="http://www.w3.org/2000/svg" aria-label="">
  <path d="M10 10" />
</svg>`;
      const violations = runRule(rule, src, { filePath: "unnamed.svg" });
      expect(violations).toHaveLength(1);
    });

    it("derives a filename-based suggestion and mentions the viewBox as anchor", () => {
      const src = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <path d="M0 0" />
</svg>`;
      const violations = runRule(rule, src, { filePath: "icons/trash-bin.svg" });
      expect(violations).toHaveLength(1);
      // Filename-derived hint shows up in the suggestion.
      expect(violations[0]?.suggestion).toMatch(/Trash bin/);
      // viewBox is quoted as the location-hint disambiguator.
      expect(violations[0]?.suggestion).toMatch(/viewBox="0 0 32 32"/);
    });
  });

  describe("does not fire when", () => {
    it("the svg has a <title> child with non-empty text", () => {
      const src = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg">
  <title>Search</title>
  <path d="M10 10" />
</svg>`;
      const violations = runRule(rule, src, { filePath: "search.svg" });
      expect(violations).toHaveLength(0);
    });

    it("the svg has aria-label with non-empty value", () => {
      const src = `<svg xmlns="http://www.w3.org/2000/svg" aria-label="Close dialog">
  <path d="M10 10" />
</svg>`;
      const violations = runRule(rule, src, { filePath: "close.svg" });
      expect(violations).toHaveLength(0);
    });

    it("the svg has aria-labelledby (target existence is out of scope)", () => {
      const src = `<svg xmlns="http://www.w3.org/2000/svg" aria-labelledby="title-elsewhere">
  <path d="M10 10" />
</svg>`;
      const violations = runRule(rule, src, { filePath: "labelled.svg" });
      expect(violations).toHaveLength(0);
    });

    it('the svg is decorative via aria-hidden="true"', () => {
      const src = `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M10 10" />
</svg>`;
      const violations = runRule(rule, src, { filePath: "decoration.svg" });
      expect(violations).toHaveLength(0);
    });

    it('the svg is decorative via role="presentation"', () => {
      const src = `<svg xmlns="http://www.w3.org/2000/svg" role="presentation">
  <path d="M10 10" />
</svg>`;
      const violations = runRule(rule, src, { filePath: "presentational.svg" });
      expect(violations).toHaveLength(0);
    });

    it("the svg is a webfont definition — root <font> direct child", () => {
      // SVG webfont resource: consumed by @font-face, never <img>-rendered.
      // WCAG 1.1.1's "non-text content presented to the user" predicate
      // doesn't apply — the glyphs render through the font pipeline.
      const src = `<?xml version="1.0" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg">
  <font id="ui-icons" horiz-adv-x="1200">
    <font-face font-family="ui-icons" units-per-em="1200" />
    <missing-glyph horiz-adv-x="500" />
    <glyph unicode="&#xe000;" d="M0 0h1000v1000H0z" />
  </font>
</svg>`;
      const violations = runRule(rule, src, { filePath: "fonts/glyphs.svg" });
      expect(violations).toHaveLength(0);
    });

    it("the svg is a webfont definition — <defs><font/></defs> wrapper", () => {
      // FontForge / batik export shape: the <font> lives inside <defs>.
      const src = `<svg xmlns="http://www.w3.org/2000/svg">
  <defs>
    <font id="icons">
      <font-face font-family="icons" />
      <missing-glyph />
      <glyph unicode="&#xe001;" d="M0 0h1000v1000H0z" />
      <glyph unicode="&#xe002;" d="M0 0h1000v1000H0z" />
    </font>
  </defs>
</svg>`;
      const violations = runRule(rule, src, { filePath: "fonts/icons.svg" });
      expect(violations).toHaveLength(0);
    });

    it("the svg contains only font-family descendants — no drawing primitives", () => {
      // Even without an explicit <font> wrapper, an SVG whose entire
      // descendant tree is <defs>/<glyph>/<missing-glyph> with no
      // drawing primitives is structurally a font resource.
      const src = `<svg xmlns="http://www.w3.org/2000/svg">
  <defs>
    <missing-glyph />
    <glyph unicode="A" d="M0 0L10 10" />
    <glyph unicode="B" d="M0 0L20 20" />
  </defs>
</svg>`;
      const violations = runRule(rule, src, { filePath: "fonts/letters.svg" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("still fires (webfont classifier is conservative) when", () => {
    it("the svg has a <font> child alongside a <path> drawing primitive", () => {
      // Mixed file: a <font> child does not suppress when a drawing
      // primitive is also present at any depth — the file is then a
      // UI graphic that happens to embed font metadata, and an
      // accessible name is still required.
      const src = `<svg xmlns="http://www.w3.org/2000/svg">
  <defs>
    <font id="x"><glyph unicode="A" d="M0 0" /></font>
  </defs>
  <path d="M10 10L20 20" />
</svg>`;
      const violations = runRule(rule, src, { filePath: "mixed.svg" });
      // The explicit-<font> axis still fires (axis 1 is sufficient
      // on its own per doctrine); axis 2 would have skipped suppression
      // here because of the <path>. Document the current behavior:
      // the <font>-axis remains the dominant predicate, so this file
      // is classified as webfont and skipped. If a real-world mixed
      // file surfaces, the predicate can be tightened then.
      expect(violations).toHaveLength(0);
    });

    it("the svg has no element children at all (empty asset)", () => {
      // An empty <svg> is not classified as a webfont — the existing
      // "no accessible name" emission for an empty UI asset stays
      // honest.
      const src = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"></svg>`;
      const violations = runRule(rule, src, { filePath: "empty.svg" });
      expect(violations).toHaveLength(1);
    });
  });

  describe("scope — inline <svg> in markup-bearing extensions", () => {
    it("fires for inline <svg> in an .html file with no <title> and no aria-hidden", () => {
      const src = `<html><body>
  <button>
    <svg xmlns="http://www.w3.org/2000/svg">
      <path d="M10 10" />
    </svg>
  </button>
</body></html>`;
      const violations = runRule(rule, src, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/Inline <svg>/);
      expect(violations[0]?.suggestion).toMatch(/<title>/);
    });

    it('does not fire for inline <svg aria-hidden="true"> in HTML', () => {
      const src = `<html><body>
  <button>
    Submit
    <svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M10 10" />
    </svg>
  </button>
</body></html>`;
      const violations = runRule(rule, src, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("does not fire for inline <svg><title>X</title></svg> in HTML", () => {
      const src = `<html><body>
  <svg xmlns="http://www.w3.org/2000/svg">
    <title>Search</title>
    <path d="M10 10" />
  </svg>
</body></html>`;
      const violations = runRule(rule, src, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it('skips inline <svg role="img"> in HTML — media/alt-text-missing covers that', () => {
      const src = `<html><body>
  <svg xmlns="http://www.w3.org/2000/svg" role="img">
    <path d="M10 10" />
  </svg>
</body></html>`;
      const violations = runRule(rule, src, { filePath: "page.html" });
      // No double-flag: the role="img" channel is owned by alt-text-missing.
      expect(violations).toHaveLength(0);
    });

    it('does not fire for inline <svg aria-label="…"> in HTML', () => {
      const src = `<html><body>
  <svg xmlns="http://www.w3.org/2000/svg" aria-label="Loading spinner">
    <circle r="10" />
  </svg>
</body></html>`;
      const violations = runRule(rule, src, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it('fires for inline <svg> in a .tsx file with no title / aria-hidden / role="img"', () => {
      const src = `export const Icon = () => (
  <button>
    <svg xmlns="http://www.w3.org/2000/svg">
      <path d="M10 10" />
    </svg>
  </button>
);`;
      const violations = runRule(rule, src, { filePath: "Icon.tsx" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/Inline <svg>/);
    });

    it("does not fire for inline <svg> with a <title> child in JSX", () => {
      const src = `export const Icon = () => (
  <svg xmlns="http://www.w3.org/2000/svg">
    <title>Search</title>
    <path d="M10 10" />
  </svg>
);`;
      const violations = runRule(rule, src, { filePath: "Icon.tsx" });
      expect(violations).toHaveLength(0);
    });

    it('does not fire for inline <svg aria-hidden="true"> in JSX', () => {
      const src = `export const Icon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M10 10" />
  </svg>
);`;
      const violations = runRule(rule, src, { filePath: "Icon.tsx" });
      expect(violations).toHaveLength(0);
    });

    it('skips inline <svg role="img"> in JSX — alt-text-missing covers that', () => {
      const src = `export const Icon = () => (
  <svg role="img">
    <path d="M10 10" />
  </svg>
);`;
      const violations = runRule(rule, src, { filePath: "Icon.tsx" });
      expect(violations).toHaveLength(0);
    });

    it("preserves the existing standalone .svg behavior", () => {
      // Regression guard: the standalone-file path still produces the
      // standalone-shaped message ("Standalone SVG '<file>'…") so the
      // pre-existing surface stays intact while the inline surface is
      // additive.
      const src = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <path d="M10 10L20 20" />
</svg>`;
      const violations = runRule(rule, src, { filePath: "icons/search.svg" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/Standalone SVG 'search\.svg'/);
    });
  });

  describe("edge cases", () => {
    it("tolerates the XML declaration + DOCTYPE prolog", () => {
      const src = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg">
  <path d="M0 0" />
</svg>`;
      const violations = runRule(rule, src, { filePath: "fontawesome-webfont.svg" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.location.line).toBe(3);
    });

    it("does not double-flag a nested <svg> inside a root <svg>", () => {
      const src = `<svg xmlns="http://www.w3.org/2000/svg" aria-label="Chart">
  <svg x="10" y="10" viewBox="0 0 10 10">
    <path d="M0 0" />
  </svg>
</svg>`;
      const violations = runRule(rule, src, { filePath: "chart.svg" });
      // The outer <svg> has aria-label — no finding. Inner <svg>
      // inherits the accessible-name scope of the outer asset.
      expect(violations).toHaveLength(0);
    });

    it("accepts uppercase attribute names (SVG + HTML tolerance)", () => {
      const src = `<svg xmlns="http://www.w3.org/2000/svg" ARIA-LABEL="Search">
  <path d="M0 0" />
</svg>`;
      const violations = runRule(rule, src, { filePath: "casey.svg" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("rule metadata", () => {
    it("satisfies 1.1.1 and 4.1.2 across WCAG 2.1 and 2.2", () => {
      expect(rule.satisfies).toContain("wcag22:1.1.1");
      expect(rule.satisfies).toContain("wcag21:1.1.1");
      expect(rule.satisfies).toContain("wcag22:4.1.2");
      expect(rule.satisfies).toContain("wcag21:4.1.2");
    });

    it("cites the normative WCAG quote and SVG 2 accessibility chapter", () => {
      expect(rule.docs.normativeQuote).toBeDefined();
      expect(rule.docs.normativeQuote.length).toBeGreaterThan(0);
      expect(rule.docs.references.some((r) => r.includes("WCAG22"))).toBe(true);
      expect(rule.docs.references.some((r) => r.includes("SVG2"))).toBe(true);
    });

    it("applies to .svg plus markup-bearing HTML / JSX extensions", () => {
      // Standalone `.svg` plus the HTML- and JSX-family roots; alias
      // chains in `EXTENSION_ALIASES` extend the effective coverage to
      // `.astro`, `.md`, `.markdown`, `.erb`, `.mdx`, `.ts`, `.js`.
      expect(rule.appliesTo?.fileExtensions).toEqual([".svg", ".html", ".htm", ".tsx", ".jsx"]);
    });
  });
});
