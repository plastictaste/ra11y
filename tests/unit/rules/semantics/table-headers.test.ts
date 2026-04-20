import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/semantics/table-headers.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule semantics/table-headers", () => {
  describe("HTML: fires when", () => {
    it("a table has td cells but no th cells", () => {
      const violations = runRule(
        rule,
        `<table>
          <tr><td>Product</td><td>Price</td></tr>
          <tr><td>Widget</td><td>$50</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("semantics/table-headers");
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.message).toContain("no <th>");
      expect(violations[0]?.message).toContain("4 <td> cells");
      expect(violations[0]?.suggestion).toContain('scope="col"');
    });

    it("a table has a caption but no th (caption is prose, not per-cell headers)", () => {
      const violations = runRule(
        rule,
        `<table>
          <caption>Quarterly sales</caption>
          <tr><td>Q1</td><td>$100</td></tr>
          <tr><td>Q2</td><td>$200</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("<td>");
    });

    it("a table wrapped in a figure still fires when it has no th", () => {
      const violations = runRule(
        rule,
        `<figure>
          <figcaption>Prices</figcaption>
          <table>
            <tr><td>Widget</td><td>$50</td></tr>
          </table>
        </figure>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("nested tables are evaluated independently: inner lacks th, outer has th", () => {
      // Outer table has a th — not flagged. Inner table has only td — flagged.
      const violations = runRule(
        rule,
        `<table>
          <tr><th>Outer</th></tr>
          <tr><td>
            <table>
              <tr><td>InnerA</td><td>InnerB</td></tr>
            </table>
          </td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("2 <td>");
    });

    it("nested tables are evaluated independently: outer lacks th, inner has th", () => {
      // Outer has one td containing another table (the inner table's td
      // doesn't count for the outer because we stop at nested tables).
      // The outer has 1 <td> with no <th> → flagged. Inner has <th> + <td>
      // → fine. Therefore one violation.
      const violations = runRule(
        rule,
        `<table>
          <tr><td>
            <table>
              <tr><th>Inner header</th><td>Inner value</td></tr>
            </table>
          </td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
    });
  });

  describe("HTML: does not fire when", () => {
    it("a table has th in thead and td in tbody", () => {
      const violations = runRule(
        rule,
        `<table>
          <thead><tr><th scope="col">Product</th><th scope="col">Price</th></tr></thead>
          <tbody><tr><td>Widget</td><td>$50</td></tr></tbody>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("a table has th in the first row and td afterwards", () => {
      const violations = runRule(
        rule,
        `<table>
          <tr><th>Product</th><th>Price</th></tr>
          <tr><td>Widget</td><td>$50</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it('the table is marked role="presentation" (layout table)', () => {
      const violations = runRule(
        rule,
        `<table role="presentation">
          <tr><td>Logo</td><td>Nav</td></tr>
          <tr><td>Content</td><td>Sidebar</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it('the table is marked role="none" (also layout)', () => {
      const violations = runRule(
        rule,
        `<table role="none">
          <tr><td>A</td><td>B</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the table has no td cells at all (empty/structural)", () => {
      const violations = runRule(rule, `<table></table>`, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });

    it("the table has only th cells (all-header edge case)", () => {
      const violations = runRule(
        rule,
        `<table>
          <tr><th>A</th><th>B</th><th>C</th></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it('the table has row headers (scope="row") and td values', () => {
      const violations = runRule(
        rule,
        `<table>
          <tr><th scope="row">Widget</th><td>$50</td></tr>
          <tr><th scope="row">Gadget</th><td>$75</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires when", () => {
    it("a JSX table has td but no th", () => {
      const violations = runRule(
        rule,
        `const X = (
          <table>
            <tr><td>Widget</td><td>$50</td></tr>
          </table>
        );`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.message).toContain("2 <td>");
    });
  });

  describe("JSX: does not fire when", () => {
    it("a JSX table has th in the first row", () => {
      const violations = runRule(
        rule,
        `const X = (
          <table>
            <tr><th>Product</th><th>Price</th></tr>
            <tr><td>Widget</td><td>$50</td></tr>
          </table>
        );`,
      );
      expect(violations).toHaveLength(0);
    });

    it('a JSX table is marked role="presentation"', () => {
      const violations = runRule(
        rule,
        `const X = (
          <table role="presentation">
            <tr><td>Logo</td><td>Nav</td></tr>
          </table>
        );`,
      );
      expect(violations).toHaveLength(0);
    });

    it('a JSX table with role="Presentation" (mixed case) is treated as layout', () => {
      const violations = runRule(
        rule,
        `const X = (
          <table role="Presentation">
            <tr><td>Logo</td><td>Nav</td></tr>
          </table>
        );`,
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("fix suggestion: header detection", () => {
    it("inlines detected column headers when the first row is short title-cased text", () => {
      const violations = runRule(
        rule,
        `<table>
          <tr><td>Name</td><td>Email</td><td>Role</td><td>Last Login</td></tr>
          <tr><td>ada lovelace</td><td>ada@example.com</td><td>admin</td><td>2026-04-01</td></tr>
          <tr><td>grace hopper</td><td>grace@example.com</td><td>admin</td><td>2026-03-28</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      const suggestion = violations[0]?.suggestion ?? "";
      expect(suggestion).toContain("First row of <table> appears to contain header text");
      expect(suggestion).toContain("`Name`");
      expect(suggestion).toContain("`Email`");
      expect(suggestion).toContain("`Role`");
      expect(suggestion).toContain("`Last Login`");
      expect(suggestion).toContain('scope="col"');
    });

    it('recommends scope="row" when the first column holds short title-cased labels', () => {
      const violations = runRule(
        rule,
        `<table>
          <tr><td>Widget</td><td>$50</td><td>12</td></tr>
          <tr><td>Gadget</td><td>$75</td><td>8</td></tr>
          <tr><td>Sprocket</td><td>$20</td><td>40</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      const suggestion = violations[0]?.suggestion ?? "";
      expect(suggestion).toContain("First column of <table>");
      expect(suggestion).toContain("`Widget`");
      expect(suggestion).toContain("`Gadget`");
      expect(suggestion).toContain("`Sprocket`");
      expect(suggestion).toContain('scope="row"');
    });

    it("falls back to the generic ladder when the first row is numeric-only", () => {
      const violations = runRule(
        rule,
        `<table>
          <tr><td>2024</td><td>2025</td><td>2026</td></tr>
          <tr><td>100</td><td>200</td><td>300</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      const suggestion = violations[0]?.suggestion ?? "";
      expect(suggestion).not.toContain("First row of <table>");
      expect(suggestion).not.toContain("First column of <table>");
      expect(suggestion).toContain('scope="col"');
      expect(suggestion).toContain('scope="row"');
      expect(suggestion).toContain('role="presentation"');
    });

    it("mentions both scopes + colgroup when both row and column look header-shaped", () => {
      const violations = runRule(
        rule,
        `<table>
          <tr><td>Metric</td><td>Q1</td><td>Q2</td><td>Q3</td></tr>
          <tr><td>Revenue</td><td>100</td><td>120</td><td>150</td></tr>
          <tr><td>Expenses</td><td>80</td><td>90</td><td>95</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      const suggestion = violations[0]?.suggestion ?? "";
      expect(suggestion).toContain("First row of <table> appears to contain column headers");
      expect(suggestion).toContain("first column of each row appears to hold row headers");
      expect(suggestion).toContain('scope="col"');
      expect(suggestion).toContain('scope="row"');
      expect(suggestion).toContain('scope="colgroup"');
      expect(suggestion).toContain("`Metric`");
      expect(suggestion).toContain("`Revenue`");
      expect(suggestion).toContain("`Expenses`");
    });

    it("applies the same header detection to JSX tables", () => {
      const violations = runRule(
        rule,
        `const X = (
          <table>
            <tr><td>Name</td><td>Email</td><td>Role</td></tr>
            <tr><td>Ada</td><td>ada@example.com</td><td>admin</td></tr>
          </table>
        );`,
      );
      expect(violations).toHaveLength(1);
      const suggestion = violations[0]?.suggestion ?? "";
      expect(suggestion).toContain("First row of <table>");
      expect(suggestion).toContain("`Name`");
      expect(suggestion).toContain("`Email`");
      expect(suggestion).toContain("`Role`");
      expect(suggestion).toContain('scope="col"');
    });
  });

  describe("rule metadata", () => {
    it("declares wcag22:1.3.1 and wcag21:1.3.1", () => {
      expect(rule.satisfies).toContain("wcag22:1.3.1");
      expect(rule.satisfies).toContain("wcag21:1.3.1");
    });

    it("is node-scoped and severity=warning", () => {
      expect(rule.scope).toBe("node");
      expect(rule.severity).toBe("warning");
    });

    it("has a normativeQuote matching WCAG 1.3.1", () => {
      expect(rule.docs.normativeQuote).toContain("Information, structure, and relationships");
    });
  });
});
