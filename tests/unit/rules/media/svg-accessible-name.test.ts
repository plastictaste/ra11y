import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/media/svg-accessible-name.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule media/svg-accessible-name", () => {
  describe("fires a violation when", () => {
    it("a bare <svg> inside a <button> with no name has no <title>, role, or use", () => {
      const src = `<button><svg viewBox="0 0 24 24"><path d="M0 0"/></svg></button>`;
      const violations = runRule(rule, src, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("media/svg-accessible-name");
      expect(violations[0]?.criteria).toContain("wcag22:1.1.1");
      expect(violations[0]?.suggestion).toMatch(/<title>/);
    });

    it("a bare <svg> inside an <a href> with no name has no accessible-name pathway", () => {
      const src = `<a href="/search"><svg viewBox="0 0 24 24"><path d="M0 0"/></svg></a>`;
      const violations = runRule(rule, src, { filePath: "nav.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/<a>/);
    });

    it('a bare <svg> inside a role="button" wrapper has no accessible name', () => {
      const src = `<div role="button"><svg viewBox="0 0 24 24"><path d="M0 0"/></svg></div>`;
      const violations = runRule(rule, src, { filePath: "panel.html" });
      expect(violations).toHaveLength(1);
    });

    it('the <svg> has role="img" but no aria-label or aria-labelledby', () => {
      // role="img" without label fails the role-img pathway; no <title>
      // child either, so the SVG has no accessible name.
      const src = `<button><svg role="img" viewBox="0 0 24 24"><path d="M0 0"/></svg></button>`;
      const violations = runRule(rule, src, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
    });

    it("the <use href> points at a non-existent #id (dangling reference)", () => {
      const src = `<button><svg><use href="#missing-icon"/></svg></button>`;
      const violations = runRule(rule, src, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/dangling/);
    });

    it("the <use href> points at an external sprite (unresolvable from static analysis)", () => {
      const src = `<button><svg><use href="/icons.svg#search"/></svg></button>`;
      const violations = runRule(rule, src, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/external sprite/);
      expect(violations[0]?.suggestion).toMatch(/Read the sprite file/);
    });

    it("the <use> resolves to a same-file <symbol> with no <title>", () => {
      const src = `<svg style="display:none"><symbol id="search"><path d="M0 0"/></symbol></svg>
<button><svg><use href="#search"/></svg></button>`;
      const violations = runRule(rule, src, { filePath: "sprite-page.html" });
      expect(violations).toHaveLength(1);
      // The symbol exists but has no <title>; surfaced as dangling.
      expect(violations[0]?.message).toMatch(/dangling|reference/);
    });

    it("fires in JSX with a bare <svg> inside <button>", () => {
      const src = `export const Icon = () => (
  <button>
    <svg viewBox="0 0 24 24"><path d="M0 0" /></svg>
  </button>
);`;
      const violations = runRule(rule, src, { filePath: "Icon.tsx" });
      expect(violations).toHaveLength(1);
    });

    it("fires in JSX for xlinkHref dangling reference", () => {
      const src = `export const Icon = () => (
  <button>
    <svg><use xlinkHref="#missing"/></svg>
  </button>
);`;
      const violations = runRule(rule, src, { filePath: "Icon.tsx" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/dangling/);
    });
  });

  describe("does not fire when", () => {
    it("the <svg> has a <title> child with non-empty text", () => {
      const src = `<button><svg viewBox="0 0 24 24"><title>Search</title><path d="M0 0"/></svg></button>`;
      const violations = runRule(rule, src, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it('the <svg> has role="img" + aria-label', () => {
      const src = `<button><svg role="img" aria-label="Search" viewBox="0 0 24 24"><path d="M0 0"/></svg></button>`;
      const violations = runRule(rule, src, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it('the <svg> has role="img" + aria-labelledby', () => {
      const src = `<p id="lbl">Search</p>
<button><svg role="img" aria-labelledby="lbl"><path d="M0 0"/></svg></button>`;
      const violations = runRule(rule, src, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the <use> resolves to a same-file <symbol> with a non-empty <title>", () => {
      const src = `<svg style="display:none"><symbol id="search-icon"><title>Search</title><path d="M0 0"/></symbol></svg>
<button><svg><use href="#search-icon"/></svg></button>`;
      const violations = runRule(rule, src, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it('the <svg> is marked aria-hidden="true"', () => {
      const src = `<button aria-label="Search"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M0 0"/></svg></button>`;
      const violations = runRule(rule, src, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the parent <button> already carries an accessible name (parent-named, SVG functionally decorative)", () => {
      // When the parent has its own name, the SVG is the icon and the
      // remediation is aria-hidden, but the AT outcome is correct, so
      // we don't fire. (Stays out of icon-font-hidden's lane.)
      const src = `<button aria-label="Search"><svg viewBox="0 0 24 24"><path d="M0 0"/></svg></button>`;
      const violations = runRule(rule, src, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the parent <button> has visible text alongside the SVG", () => {
      const src = `<button><svg viewBox="0 0 24 24"><path d="M0 0"/></svg> Search</button>`;
      const violations = runRule(rule, src, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the <a> has no href (placeholder, not an interactive control)", () => {
      const src = `<a><svg viewBox="0 0 24 24"><path d="M0 0"/></svg></a>`;
      const violations = runRule(rule, src, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the <svg> sits in non-interactive prose (no fire by design)", () => {
      // Prose-context SVGs are out of scope — too ambiguous to flag.
      const src = `<p>An illustration: <svg viewBox="0 0 24 24"><path d="M0 0"/></svg></p>`;
      const violations = runRule(rule, src, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("a JSX <button> with an expression child is treated as labeled", () => {
      const src = `export const Icon = ({label}: {label: string}) => (
  <button>
    <svg viewBox="0 0 24 24"><path d="M0 0" /></svg>
    {label}
  </button>
);`;
      const violations = runRule(rule, src, { filePath: "Icon.tsx" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("does not double-fire for a nested <svg> inside another <svg>", () => {
      const src = `<button><svg viewBox="0 0 24 24"><svg x="10"><path d="M0 0"/></svg></svg></button>`;
      const violations = runRule(rule, src, { filePath: "page.html" });
      // Only the outer <svg> is checked — inner is opaque to the SVG-stop walker.
      expect(violations).toHaveLength(1);
    });

    it("walks through non-interactive intermediate wrappers (<span>, <div>)", () => {
      const src = `<button><span class="icon-wrap"><svg viewBox="0 0 24 24"><path d="M0 0"/></svg></span></button>`;
      const violations = runRule(rule, src, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
    });

    it("stops descent at a nested interactive element (counted on its own pass)", () => {
      // Inner <button> has no SVG of its own; outer <button> should not
      // claim the inner button's would-be SVG. There IS no SVG in the
      // inner button, so we test that the outer doesn't double-walk.
      const src = `<button><span><button><svg><title>Inner</title><path d="M0 0"/></svg></button></span></button>`;
      const violations = runRule(rule, src, { filePath: "page.html" });
      // Outer button has no SVG of its own (the only svg is inside the
      // nested button, which is named via <title>). Both should pass.
      expect(violations).toHaveLength(0);
    });

    it('treats role="presentation" / role="none" on the <svg> as decorative', () => {
      const src = `<button><svg role="presentation"><path d="M0 0"/></svg></button>
<button><svg role="none"><path d="M0 0"/></svg></button>`;
      const violations = runRule(rule, src, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("an empty <title> child does not satisfy the name requirement", () => {
      const src = `<button><svg><title>   </title><path d="M0 0"/></svg></button>`;
      const violations = runRule(rule, src, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
    });

    it("recognises xlink:href in HTML alongside href in SVG 2", () => {
      const src = `<svg style="display:none"><symbol id="a"><title>A</title></symbol></svg>
<button><svg><use xlink:href="#a"/></svg></button>`;
      const violations = runRule(rule, src, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("rule metadata", () => {
    it("satisfies WCAG 1.1.1 across 2.1 and 2.2", () => {
      expect(rule.satisfies).toContain("wcag22:1.1.1");
      expect(rule.satisfies).toContain("wcag21:1.1.1");
    });

    it("declares the verify-in-source fix lane (matches alt-text-missing)", () => {
      expect(rule.fixClass).toBe("verify-in-source");
    });

    it("applies to HTML and JSX surfaces (inline SVG context, not standalone .svg)", () => {
      expect(rule.appliesTo?.fileExtensions).toEqual([".html", ".htm", ".tsx", ".jsx"]);
    });

    it("cites the WCAG normative quote and SVG 2 accessibility chapter", () => {
      expect(rule.docs.normativeQuote).toBeDefined();
      expect(rule.docs.references.some((r) => r.includes("WCAG22"))).toBe(true);
      expect(rule.docs.references.some((r) => r.includes("SVG2"))).toBe(true);
    });
  });
});
