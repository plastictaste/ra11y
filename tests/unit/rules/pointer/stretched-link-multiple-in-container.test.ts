import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/pointer/stretched-link-multiple-in-container.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule pointer/stretched-link-multiple-in-container", () => {
  describe("HTML: fires when", () => {
    it("two stretched-link anchors share a .card ancestor", () => {
      const violations = runRule(
        rule,
        `<div class="card">
           <div class="card-body">
             <a href="/a" class="stretched-link">View</a>
             <a href="/b" class="stretched-link">Compare</a>
           </div>
         </div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("pointer/stretched-link-multiple-in-container");
      expect(violations[0]?.severity).toBe("error");
      expect(violations[0]?.criteria).toContain("wcag22:2.4.4");
      expect(violations[0]?.message).toContain("stretched-link");
      expect(violations[0]?.message).toContain(`<div class="card">`);
      expect(violations[0]?.suggestion).toMatch(/drop the `stretched-link`/);
    });

    it("three stretched-link anchors in one .card emit two violations (pairs beyond the first)", () => {
      const violations = runRule(
        rule,
        `<div class="card">
           <a href="/a" class="stretched-link">A</a>
           <a href="/b" class="stretched-link">B</a>
           <a href="/c" class="stretched-link">C</a>
         </div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(2);
      for (const v of violations) {
        expect(v.message).toContain("2 other stretched-link anchors");
      }
    });

    it('positioned ancestor comes from an inline style="position: relative"', () => {
      const violations = runRule(
        rule,
        `<div style="position: relative">
           <a href="/a" class="stretched-link">A</a>
           <a href="/b" class="stretched-link">B</a>
         </div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("positioned ancestor comes from the .position-relative utility class", () => {
      const violations = runRule(
        rule,
        `<section class="wrap position-relative">
           <a href="/a" class="stretched-link">A</a>
           <a href="/b" class="stretched-link">B</a>
         </section>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
    });
  });

  describe("HTML: does not fire when", () => {
    it("only one stretched-link anchor lives inside a .card", () => {
      const violations = runRule(
        rule,
        `<div class="card">
           <div class="card-body">
             <a href="/a" class="stretched-link">View</a>
           </div>
         </div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("two stretched-link anchors sit in different cards", () => {
      const violations = runRule(
        rule,
        `<div class="card">
           <a href="/a" class="stretched-link">A</a>
         </div>
         <div class="card">
           <a href="/b" class="stretched-link">B</a>
         </div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("two anchors in a .card but only one carries stretched-link", () => {
      const violations = runRule(
        rule,
        `<div class="card">
           <a href="/a" class="stretched-link">Primary</a>
           <a href="/details">Details</a>
         </div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("two stretched-link anchors exist but their ancestor is not positioned", () => {
      const violations = runRule(
        rule,
        `<div class="panel">
           <a href="/a" class="stretched-link">A</a>
           <a href="/b" class="stretched-link">B</a>
         </div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires when", () => {
    it('two stretched-link anchors share a className="card" ancestor', () => {
      const violations = runRule(
        rule,
        `export const Card = () => (
           <div className="card">
             <div className="card-body">
               <a href="/a" className="stretched-link">View</a>
               <a href="/b" className="stretched-link">Compare</a>
             </div>
           </div>
         );`,
        { filePath: "Card.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.criteria).toContain("wcag22:2.4.4");
      expect(violations[0]?.message).toContain(`<div className="card">`);
    });

    it('positioned ancestor comes from className="position-absolute"', () => {
      const violations = runRule(
        rule,
        `export const Box = () => (
           <section className="wrap position-absolute">
             <a href="/a" className="stretched-link">A</a>
             <a href="/b" className="stretched-link">B</a>
           </section>
         );`,
        { filePath: "Box.tsx" },
      );
      expect(violations).toHaveLength(1);
    });

    it("HTML-style class attribute on JSX still counts", () => {
      const violations = runRule(
        rule,
        `export const Card = () => (
           <div class="card">
             <a href="/a" class="stretched-link">A</a>
             <a href="/b" class="stretched-link">B</a>
           </div>
         );`,
        { filePath: "Card.tsx" },
      );
      expect(violations).toHaveLength(1);
    });
  });

  describe("JSX: does not fire when", () => {
    it("exactly one stretched-link anchor in a .card", () => {
      const violations = runRule(
        rule,
        `export const Card = () => (
           <div className="card">
             <a href="/a" className="stretched-link">View</a>
           </div>
         );`,
        { filePath: "Card.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("className is an expression so the class list is unknown", () => {
      const violations = runRule(
        rule,
        `export const Card = ({ variant }: { variant: string }) => (
           <div className={variant}>
             <a href="/a" className="stretched-link">A</a>
             <a href="/b" className="stretched-link">B</a>
           </div>
         );`,
        { filePath: "Card.tsx" },
      );
      // Expression-valued className can't be statically resolved — accept
      // as a false-negative; the agent reads the source.
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("nested positioned ancestors: anchors group under the nearest one", () => {
      const violations = runRule(
        rule,
        `<section class="position-relative">
           <div class="card">
             <a href="/a" class="stretched-link">A</a>
             <a href="/b" class="stretched-link">B</a>
           </div>
           <a href="/c" class="stretched-link">Outside card</a>
         </section>`,
        { filePath: "index.html" },
      );
      // Inner .card groups A+B (one violation); outer section groups C alone.
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(`<div class="card">`);
    });

    it("stretched-link on a non-anchor is ignored (spec requires an <a>)", () => {
      const violations = runRule(
        rule,
        `<div class="card">
           <button class="stretched-link">A</button>
           <a href="/b" class="stretched-link">B</a>
         </div>`,
        { filePath: "index.html" },
      );
      // Only one actual stretched-link <a> under the card; no pair.
      expect(violations).toHaveLength(0);
    });

    it("inline style with position: static does NOT establish a positioned ancestor", () => {
      const violations = runRule(
        rule,
        `<div style="position: static">
           <a href="/a" class="stretched-link">A</a>
           <a href="/b" class="stretched-link">B</a>
         </div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("rule metadata", () => {
    it("satisfies wcag22:2.4.4 and wcag21:2.4.4", () => {
      expect(rule.satisfies).toContain("wcag22:2.4.4");
      expect(rule.satisfies).toContain("wcag21:2.4.4");
    });

    it("has a normativeQuote citing WCAG 2.4.4", () => {
      expect(rule.docs.normativeQuote).toBeDefined();
      expect(rule.docs.references[0]).toContain("link-purpose-in-context");
    });
  });
});
