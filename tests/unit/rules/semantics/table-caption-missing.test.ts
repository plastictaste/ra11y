import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/semantics/table-caption-missing.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule semantics/table-caption-missing", () => {
  describe("HTML: fires when", () => {
    it("a data table has no caption and no ARIA labeling", () => {
      const violations = runRule(
        rule,
        `<table>
          <thead><tr><th scope="col">Region</th><th scope="col">Q1</th></tr></thead>
          <tbody><tr><td>North</td><td>$100</td></tr></tbody>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("semantics/table-caption-missing");
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.message).toContain("no <caption>");
      expect(violations[0]?.suggestion).toContain("<caption>");
    });

    it("a data table is preceded by a heading — suggestion uses the heading text", () => {
      const violations = runRule(
        rule,
        `<section>
          <h2>Quarterly sales by region</h2>
          <table>
            <tr><th scope="col">Region</th></tr>
            <tr><td>North</td></tr>
          </table>
        </section>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("<caption>Quarterly sales by region</caption>");
      expect(violations[0]?.suggestion).toContain("preceding heading");
    });

    it("a data table sits inside a <figure> with a <figcaption> — suggestion uses the figcaption", () => {
      const violations = runRule(
        rule,
        `<figure>
          <figcaption>Product inventory</figcaption>
          <table>
            <tr><th scope="col">SKU</th></tr>
            <tr><td>A-001</td></tr>
          </table>
        </figure>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("<caption>Product inventory</caption>");
      expect(violations[0]?.suggestion).toContain("<figcaption>");
    });

    it("an empty <caption></caption> child is treated as no label", () => {
      const violations = runRule(
        rule,
        `<table>
          <caption></caption>
          <tr><th>Header</th></tr>
          <tr><td>Cell</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("aria-label with only whitespace is treated as no label", () => {
      const violations = runRule(
        rule,
        `<table aria-label="   ">
          <tr><th>Header</th></tr>
          <tr><td>Cell</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("nested tables are evaluated independently: outer labeled, inner unlabeled", () => {
      const violations = runRule(
        rule,
        `<table>
          <caption>Outer table</caption>
          <tr><td>
            <table>
              <tr><th>Inner header</th></tr>
              <tr><td>Inner value</td></tr>
            </table>
          </td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      // The flagged one is the inner table.
      expect(violations[0]?.message).toContain("no <caption>");
    });
  });

  describe("HTML: does not fire when", () => {
    it("a table has a <caption> child with text", () => {
      const violations = runRule(
        rule,
        `<table>
          <caption>Quarterly sales</caption>
          <tr><th>Region</th></tr>
          <tr><td>North</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("a table has aria-label with real text", () => {
      const violations = runRule(
        rule,
        `<table aria-label="Quarterly sales by region">
          <tr><th>Region</th></tr>
          <tr><td>North</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("a table has aria-labelledby", () => {
      const violations = runRule(
        rule,
        `<h2 id="sales">Sales</h2>
        <table aria-labelledby="sales">
          <tr><th>Region</th></tr>
          <tr><td>North</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it('a table has role="presentation"', () => {
      const violations = runRule(
        rule,
        `<table role="presentation">
          <tr><td>left</td><td>right</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it('a table has role="none"', () => {
      const violations = runRule(
        rule,
        `<table role="none">
          <tr><td>left</td><td>right</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("a table is empty (no td/th descendants) — decorative scaffolding", () => {
      const violations = runRule(rule, `<table></table>`, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });

    it("a table has a non-empty title attribute", () => {
      const violations = runRule(
        rule,
        `<table title="Inventory">
          <tr><th>SKU</th></tr>
          <tr><td>A-001</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires when", () => {
    it("a data table has no caption, no aria-label, no aria-labelledby", () => {
      const violations = runRule(
        rule,
        `const x = (
          <table>
            <thead><tr><th scope="col">Region</th></tr></thead>
            <tbody><tr><td>North</td></tr></tbody>
          </table>
        );`,
        { filePath: "file.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("semantics/table-caption-missing");
      expect(violations[0]?.suggestion).toContain("<caption>");
    });

    it("an empty <caption /> child is treated as no label", () => {
      const violations = runRule(
        rule,
        `const x = (
          <table>
            <caption />
            <tr><th>Header</th></tr>
            <tr><td>Cell</td></tr>
          </table>
        );`,
        { filePath: "file.tsx" },
      );
      expect(violations).toHaveLength(1);
    });

    it("a preceding <h2> seeds the suggested caption text", () => {
      const violations = runRule(
        rule,
        `const x = (
          <section>
            <h2>Product inventory</h2>
            <table>
              <tr><th>SKU</th></tr>
              <tr><td>A-001</td></tr>
            </table>
          </section>
        );`,
        { filePath: "file.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("<caption>Product inventory</caption>");
    });
  });

  describe("JSX: does not fire when", () => {
    it("a table has a <caption>Text</caption> child", () => {
      const violations = runRule(
        rule,
        `const x = (
          <table>
            <caption>Quarterly sales</caption>
            <tr><th>Region</th></tr>
            <tr><td>North</td></tr>
          </table>
        );`,
        { filePath: "file.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it('a table has aria-label="…"', () => {
      const violations = runRule(
        rule,
        `const x = (
          <table aria-label="Quarterly sales by region">
            <tr><th>Region</th></tr>
            <tr><td>North</td></tr>
          </table>
        );`,
        { filePath: "file.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("aria-label bound to an expression is treated as labeled (agent verifies in source)", () => {
      const violations = runRule(
        rule,
        `const x = (
          <table aria-label={t("sales.title")}>
            <tr><th>Region</th></tr>
            <tr><td>North</td></tr>
          </table>
        );`,
        { filePath: "file.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("a <caption> child with expression content is treated as labeled", () => {
      const violations = runRule(
        rule,
        `const x = (
          <table>
            <caption>{title}</caption>
            <tr><th>Region</th></tr>
            <tr><td>North</td></tr>
          </table>
        );`,
        { filePath: "file.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it('a table with role="presentation" is skipped', () => {
      const violations = runRule(
        rule,
        `const x = (
          <table role="presentation">
            <tr><td>left</td><td>right</td></tr>
          </table>
        );`,
        { filePath: "file.tsx" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("rule metadata", () => {
    it("satisfies WCAG 1.3.1 across all four loaded standards", () => {
      expect(rule.satisfies).toEqual([
        "wcag22:1.3.1",
        "wcag21:1.3.1",
        "section508:1.3.1",
        "en301549:9.1.3.1",
      ]);
    });
  });
});
