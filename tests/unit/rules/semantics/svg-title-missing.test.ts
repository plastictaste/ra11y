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
  });

  describe("scope", () => {
    it("does not fire for inline <svg> in an .html file (alt-text-missing covers that)", () => {
      const src = `<html><body>
  <svg xmlns="http://www.w3.org/2000/svg" role="img">
    <path d="M10 10" />
  </svg>
</body></html>`;
      const violations = runRule(rule, src, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("does not fire for inline <svg> in a .tsx file", () => {
      const src = `export const Icon = () => (
  <svg role="img">
    <path d="M10 10" />
  </svg>
);`;
      const violations = runRule(rule, src, { filePath: "Icon.tsx" });
      expect(violations).toHaveLength(0);
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

    it("only applies to .svg files", () => {
      expect(rule.appliesTo?.fileExtensions).toEqual([".svg"]);
    });
  });
});
