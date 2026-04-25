import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/semantics/layout-table-no-presentation-role.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule semantics/layout-table-no-presentation-role", () => {
  describe("HTML: fires when", () => {
    it("a <table> has only <td> cells, no <th>/<thead>/<tfoot>/<caption>/scope/role", () => {
      const violations = runRule(
        rule,
        `<table>
          <tr><td><img src="logo.png" alt="Acme"/></td><td>Header text</td></tr>
          <tr><td>Body cell A</td><td>Body cell B</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("semantics/layout-table-no-presentation-role");
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.message).toContain("appears to be a layout table");
      expect(violations[0]?.suggestion).toContain('role="presentation"');
      expect(violations[0]?.suggestion).toContain("2-row × 2-column");
    });

    it("a single-row layout table fires (the predicate doesn't depend on dimensions)", () => {
      const violations = runRule(
        rule,
        `<table>
          <tr><td>left</td><td>middle</td><td>right</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("1-row × 3-column");
    });

    it('treats role="" as absent and still fires', () => {
      const violations = runRule(
        rule,
        `<table role="">
          <tr><td>a</td><td>b</td></tr>
          <tr><td>c</td><td>d</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("flags the outer layout table even when an inner data table exists", () => {
      // Nested tables are evaluated independently. The outer table has only
      // <td> cells (the inner <table> is opaque to the outer's predicate),
      // so the outer should still fire while the inner is clean.
      const violations = runRule(
        rule,
        `<table>
          <tr>
            <td>Outer left layout cell</td>
            <td>
              <table>
                <caption>Inner data</caption>
                <thead><tr><th scope="col">A</th><th scope="col">B</th></tr></thead>
                <tbody><tr><td>1</td><td>2</td></tr></tbody>
              </table>
            </td>
          </tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      // The reported location must be the outer table (line 1).
      expect(violations[0]?.location.line).toBe(1);
    });
  });

  describe("HTML: does not fire when", () => {
    it('the <table> already declares role="presentation"', () => {
      const violations = runRule(
        rule,
        `<table role="presentation">
          <tr><td>a</td><td>b</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it('the <table> already declares role="none"', () => {
      const violations = runRule(
        rule,
        `<table role="none">
          <tr><td>a</td><td>b</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the table has a <th> header (clearly intended as data)", () => {
      const violations = runRule(
        rule,
        `<table>
          <tr><th>Name</th><th>Value</th></tr>
          <tr><td>Width</td><td>1024</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      // Other rules (table-th-scope-missing) handle this; we don't fire.
      expect(violations).toHaveLength(0);
    });

    it("the table has a <caption>", () => {
      const violations = runRule(
        rule,
        `<table>
          <caption>Quarterly figures</caption>
          <tr><td>Q1</td><td>$100</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("any <td> carries a scope= attribute", () => {
      // Defensive: a partial scope wiring still indicates author intent.
      const violations = runRule(
        rule,
        `<table>
          <tr><td scope="col">left</td><td>right</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("any <td> carries a headers= attribute", () => {
      const violations = runRule(
        rule,
        `<table>
          <tr><td headers="h1">left</td><td>right</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the <table> has aria-label", () => {
      const violations = runRule(
        rule,
        `<table aria-label="Pricing matrix">
          <tr><td>$10</td><td>$20</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the <table> has aria-labelledby", () => {
      const violations = runRule(
        rule,
        `<h2 id="pricing-heading">Pricing</h2>
        <table aria-labelledby="pricing-heading">
          <tr><td>$10</td><td>$20</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it('the <table> declares role="grid" (explicit ARIA opt-in)', () => {
      const violations = runRule(
        rule,
        `<table role="grid">
          <tr><td>1</td><td>2</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the table has a <thead>", () => {
      const violations = runRule(
        rule,
        `<table>
          <thead><tr><td>Header-row td</td></tr></thead>
          <tbody><tr><td>Body</td></tr></tbody>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires when", () => {
    it("a JSX <table> has only <td> cells and no markers/role", () => {
      const violations = runRule(
        rule,
        `export function Layout() {
          return (
            <table>
              <tr><td>left</td><td>right</td></tr>
              <tr><td>foot-l</td><td>foot-r</td></tr>
            </table>
          );
        }`,
        { filePath: "Layout.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain('role="presentation"');
    });
  });

  describe("JSX: does not fire when", () => {
    it('role="presentation" is declared as a string literal', () => {
      const violations = runRule(
        rule,
        `export function Layout() {
          return (
            <table role="presentation">
              <tr><td>a</td><td>b</td></tr>
            </table>
          );
        }`,
        { filePath: "Layout.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("role={...} is an expression — treat as declared (no false positives on dynamic role)", () => {
      // The author may be conditionally setting role from props.
      // Static analysis can't read the runtime value; surfacing here
      // would be the documented expression-attribute footgun.
      const violations = runRule(
        rule,
        `export function Layout({ asLayout }: { asLayout: boolean }) {
          return (
            <table role={asLayout ? "presentation" : undefined}>
              <tr><td>a</td><td>b</td></tr>
            </table>
          );
        }`,
        { filePath: "Layout.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("aria-label is provided", () => {
      const violations = runRule(
        rule,
        `export function Pricing() {
          return (
            <table aria-label="Pricing matrix">
              <tr><td>$10</td><td>$20</td></tr>
            </table>
          );
        }`,
        { filePath: "Pricing.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("any cell uses scope= or headers= (data-table intent)", () => {
      const violations = runRule(
        rule,
        `export function Mix() {
          return (
            <table>
              <tr><td scope="col">A</td><td>B</td></tr>
            </table>
          );
        }`,
        { filePath: "Mix.tsx" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("an empty <table> with no rows still fires (still no semantic markers, still no role)", () => {
      // A rare structural pathology, but the predicate is honest: no <th>,
      // no caption, no role → screen reader still announces "table, 0 rows".
      const violations = runRule(rule, `<table></table>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("0-row × 0-column");
    });

    it("title on the <table> is treated as an accessible name and suppresses the rule", () => {
      const violations = runRule(
        rule,
        `<table title="Mailing list signup form layout">
          <tr><td>a</td><td>b</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });
});
