import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/semantics/table-th-scope-missing.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule semantics/table-th-scope-missing", () => {
  describe("HTML: fires when", () => {
    it("a multi-row × multi-column table without <thead> has <th> cells with no scope", () => {
      // No <thead>/<tbody> wrappers — the HTML5 implicit scope="col"
      // carve-out does not apply, so the bare <th>s in the first row
      // still need an explicit scope.
      const violations = runRule(
        rule,
        `<table>
          <tr><th>Product</th><th>Price</th></tr>
          <tr><td>Widget</td><td>$50</td></tr>
          <tr><td>Gadget</td><td>$75</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(2);
      expect(violations[0]?.ruleId).toBe("semantics/table-th-scope-missing");
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.message).toContain("3-row × 2-column");
      expect(violations[0]?.suggestion).toContain("first row");
      expect(violations[0]?.suggestion).toContain('scope="col"');
    });

    it("flags row-header <th> cells in the first column", () => {
      const violations = runRule(
        rule,
        `<table>
          <thead><tr><th scope="col">Product</th><th scope="col">Price</th><th scope="col">Stock</th></tr></thead>
          <tbody>
            <tr><th>Widget</th><td>$50</td><td>12</td></tr>
            <tr><th>Gadget</th><td>$75</td><td>8</td></tr>
          </tbody>
        </table>`,
        { filePath: "index.html" },
      );
      // Only the two first-column <th> cells are unflagged; the header-row
      // ones already declare scope="col".
      expect(violations).toHaveLength(2);
      for (const v of violations) {
        expect(v.suggestion).toContain("first cell of its row");
        expect(v.suggestion).toContain('scope="row"');
      }
    });

    it("flags a colgroup <th> (colspan >= 2) without scope", () => {
      const violations = runRule(
        rule,
        `<table>
          <tr>
            <th colspan="2">Sales</th>
            <th colspan="2">Costs</th>
          </tr>
          <tr>
            <th scope="col">Q1</th><th scope="col">Q2</th>
            <th scope="col">Q1</th><th scope="col">Q2</th>
          </tr>
          <tr>
            <td>100</td><td>120</td>
            <td>80</td><td>90</td>
          </tr>
        </table>`,
        { filePath: "index.html" },
      );
      // The two spanning headers lack scope="colgroup". The second-row
      // headers already declare scope="col".
      expect(violations).toHaveLength(2);
      for (const v of violations) {
        expect(v.suggestion).toContain('colspan="2"');
        expect(v.suggestion).toContain('scope="colgroup"');
      }
    });

    it("flags a rowgroup <th> (rowspan >= 2) without scope", () => {
      const violations = runRule(
        rule,
        `<table>
          <tr><th scope="col">Category</th><th scope="col">Item</th><th scope="col">Qty</th></tr>
          <tr><th rowspan="2">Tools</th><td>Hammer</td><td>10</td></tr>
          <tr><td>Wrench</td><td>5</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain('rowspan="2"');
      expect(violations[0]?.suggestion).toContain('scope="rowgroup"');
    });

    it('treats scope="" / scope="invalid" as missing scope', () => {
      const violations = runRule(
        rule,
        `<table>
          <tr><th scope="">Product</th><th scope="wat">Price</th></tr>
          <tr><td>Widget</td><td>$50</td></tr>
          <tr><td>Gadget</td><td>$75</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(2);
    });

    it("flags <th> scattered in <tbody> rows even when <thead> is present", () => {
      // The implicit-col carve-out only covers <thead> > <tr> > <th>.
      // A <th> sitting in a <tbody> row is acting as a row header and
      // still needs scope="row" — implicit association doesn't apply.
      const violations = runRule(
        rule,
        `<table>
          <thead><tr><th>Category</th><th>Value</th></tr></thead>
          <tbody>
            <tr><th>Width</th><td>1024</td></tr>
            <tr><th>Height</th><td>768</td></tr>
          </tbody>
        </table>`,
        { filePath: "index.html" },
      );
      // <thead> headers are skipped (implicit scope="col"); the two
      // <tbody> row-header <th>s still fire.
      expect(violations).toHaveLength(2);
      for (const v of violations) {
        expect(v.suggestion).toContain('scope="row"');
      }
    });

    it("flags partial headers= wiring (some <td>s use it, others don't)", () => {
      const violations = runRule(
        rule,
        `<table>
          <tr><th id="p">Product</th><th id="pr">Price</th></tr>
          <tr><td headers="p">Widget</td><td>$50</td></tr>
          <tr><td headers="p">Gadget</td><td headers="pr">$75</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      // One <td> is missing headers, so the pattern isn't complete;
      // both <th>s still lack scope and both should fire.
      expect(violations).toHaveLength(2);
    });
  });

  describe("HTML: does not fire when", () => {
    it('all <th>s declare a valid scope ("col" or "row")', () => {
      const violations = runRule(
        rule,
        `<table>
          <thead><tr><th scope="col">Product</th><th scope="col">Price</th></tr></thead>
          <tbody>
            <tr><th scope="row">Widget</th><td>$50</td></tr>
            <tr><th scope="row">Gadget</th><td>$75</td></tr>
          </tbody>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the table is single-row (association is unambiguous)", () => {
      const violations = runRule(
        rule,
        `<table>
          <tr><th>Metric</th><td>42</td><td>99</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the table is single-column (association is unambiguous)", () => {
      const violations = runRule(
        rule,
        `<table>
          <tr><th>Attributes</th></tr>
          <tr><td>Red</td></tr>
          <tr><td>Heavy</td></tr>
          <tr><td>Waterproof</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it('the table is marked role="presentation"', () => {
      const violations = runRule(
        rule,
        `<table role="presentation">
          <tr><th>Logo</th><th>Title</th></tr>
          <tr><td>Image</td><td>Welcome</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it('the table is marked role="none"', () => {
      const violations = runRule(
        rule,
        `<table role="none">
          <tr><th>A</th><th>B</th></tr>
          <tr><td>1</td><td>2</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("every <td> uses complete headers= wiring to in-table <th> ids", () => {
      const violations = runRule(
        rule,
        `<table>
          <tr><th id="product">Product</th><th id="price">Price</th></tr>
          <tr><td headers="product">Widget</td><td headers="price">$50</td></tr>
          <tr><td headers="product">Gadget</td><td headers="price">$75</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("accepts scope values case-insensitively", () => {
      const violations = runRule(
        rule,
        `<table>
          <tr><th scope="COL">A</th><th scope="Col">B</th></tr>
          <tr><td>1</td><td>2</td></tr>
          <tr><td>3</td><td>4</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the table has no <th> cells at all", () => {
      const violations = runRule(
        rule,
        `<table>
          <tr><td>Widget</td><td>$50</td></tr>
          <tr><td>Gadget</td><td>$75</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("<th> sits in <thead> > <tr> with sibling <tbody> (HTML5 implicit scope=col)", () => {
      // Canonical structure that browsers and AT (JAWS / NVDA /
      // VoiceOver) all resolve via the HTML5 forming-relationships
      // algorithm — implicit scope="col" applies, so the bare <th>s
      // are spec-correct without an explicit scope attribute.
      const violations = runRule(
        rule,
        `<table>
          <thead><tr><th>Setting</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td>theme</td><td>Color theme</td></tr>
            <tr><td>locale</td><td>Display language</td></tr>
          </tbody>
        </table>`,
        { filePath: "options.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("implicit-scope carve-out tolerates whitespace text inside <thead>/<tbody>", () => {
      // Real-world markup carries newlines/indentation between row-group
      // and <tr>; the section detection must walk past text nodes.
      const violations = runRule(
        rule,
        `<table>
          <thead>
            <tr><th>Setting</th><th>Description</th></tr>
          </thead>
          <tbody>
            <tr><td>theme</td><td>Color theme</td></tr>
            <tr><td>locale</td><td>Display language</td></tr>
          </tbody>
        </table>`,
        { filePath: "options.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires when", () => {
    it("a multi-row × multi-column JSX table without <thead> has <th>s with no scope", () => {
      const violations = runRule(
        rule,
        `const X = (
          <table>
            <tr><th>Product</th><th>Price</th></tr>
            <tr><td>Widget</td><td>$50</td></tr>
            <tr><td>Gadget</td><td>$75</td></tr>
          </table>
        );`,
      );
      expect(violations).toHaveLength(2);
      expect(violations[0]?.ruleId).toBe("semantics/table-th-scope-missing");
      expect(violations[0]?.suggestion).toContain('scope="col"');
    });

    it("flags colSpan / rowSpan (React camelCase) without scope", () => {
      const violations = runRule(
        rule,
        `const X = (
          <table>
            <tr>
              <th colSpan={2}>Sales</th>
              <th colSpan="2">Costs</th>
            </tr>
            <tr>
              <th scope="col">Q1</th><th scope="col">Q2</th>
              <th scope="col">Q1</th><th scope="col">Q2</th>
            </tr>
            <tr>
              <td>100</td><td>120</td>
              <td>80</td><td>90</td>
            </tr>
          </table>
        );`,
      );
      // colSpan={2} is an expression; colSpan="2" is a string literal.
      // The literal "2" parses as 2, triggering the colgroup position.
      // The expression {2} resolves to null via getJsxAttributeString —
      // so it falls back to span=1 and the <th> is treated as first-row
      // (still flagged, with scope="col" recommendation). Both fire.
      expect(violations).toHaveLength(2);
    });
  });

  describe("JSX: does not fire when", () => {
    it("every JSX <th> declares scope", () => {
      const violations = runRule(
        rule,
        `const X = (
          <table>
            <thead><tr><th scope="col">Product</th><th scope="col">Price</th></tr></thead>
            <tbody>
              <tr><th scope="row">Widget</th><td>$50</td></tr>
              <tr><th scope="row">Gadget</th><td>$75</td></tr>
            </tbody>
          </table>
        );`,
      );
      expect(violations).toHaveLength(0);
    });

    it('a JSX table with role="presentation" is skipped', () => {
      const violations = runRule(
        rule,
        `const X = (
          <table role="presentation">
            <tr><th>Logo</th><th>Title</th></tr>
            <tr><td>Image</td><td>Welcome</td></tr>
          </table>
        );`,
      );
      expect(violations).toHaveLength(0);
    });

    it("accepts an expression-valued scope (runtime — cannot statically verify)", () => {
      const violations = runRule(
        rule,
        `const X = (
          <table>
            <tr><th scope={kind}>Product</th><th scope={kind}>Price</th></tr>
            <tr><td>Widget</td><td>$50</td></tr>
            <tr><td>Gadget</td><td>$75</td></tr>
          </table>
        );`,
      );
      expect(violations).toHaveLength(0);
    });

    it("JSX <thead> > <tr> > <th> with sibling <tbody> is implicit scope=col", () => {
      const violations = runRule(
        rule,
        `const X = (
          <table>
            <thead><tr><th>Setting</th><th>Description</th></tr></thead>
            <tbody>
              <tr><td>theme</td><td>Color theme</td></tr>
              <tr><td>locale</td><td>Display language</td></tr>
            </tbody>
          </table>
        );`,
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("nested tables are evaluated independently (outer clean, inner missing scope)", () => {
      const violations = runRule(
        rule,
        `<table>
          <tr><th scope="col">Outer A</th><th scope="col">Outer B</th></tr>
          <tr>
            <td>
              <table>
                <tr><th>Inner A</th><th>Inner B</th></tr>
                <tr><td>1</td><td>2</td></tr>
              </table>
            </td>
            <td>other</td>
          </tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(2);
      // Both firings come from the inner table.
    });

    it("nested tables: inner is single-row (skipped), outer still flags", () => {
      const violations = runRule(
        rule,
        `<table>
          <tr><th>Outer A</th><th>Outer B</th></tr>
          <tr>
            <td>
              <table>
                <tr><th>Only</th><td>row</td></tr>
              </table>
            </td>
            <td>other</td>
          </tr>
        </table>`,
        { filePath: "index.html" },
      );
      // Outer has 2 rows × 2 cols with no scope → 2 violations.
      // Inner has 1 row × 2 cells → single-row, skipped.
      expect(violations).toHaveLength(2);
    });

    it("an empty <table> with no rows is skipped (dimensions below threshold)", () => {
      const violations = runRule(rule, `<table></table>`, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });

    it("colspan expanding a single-column <th> row to multi-column still skips (only one row)", () => {
      // Single physical row, colspan makes it 3 visual columns — still
      // a single row, so the header's association is unambiguous.
      const violations = runRule(
        rule,
        `<table>
          <tr><th colspan="3">Summary</th></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("partial headers= wiring fires even when some <td> rows are complete", () => {
      const violations = runRule(
        rule,
        `<table>
          <tr><th id="a">A</th><th id="b">B</th></tr>
          <tr><td headers="a">1</td><td headers="b">2</td></tr>
          <tr><td>3</td><td>4</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      // Row 3 <td>s lack headers, so the association isn't complete for
      // the whole table — both <th> cells lack scope and both fire.
      expect(violations).toHaveLength(2);
    });
  });

  describe("rule metadata", () => {
    it("declares wcag22:1.3.1 and its equivalent criteria", () => {
      expect(rule.satisfies).toContain("wcag22:1.3.1");
      expect(rule.satisfies).toContain("wcag21:1.3.1");
      expect(rule.satisfies).toContain("section508:1.3.1");
      expect(rule.satisfies).toContain("en301549:9.1.3.1");
    });

    it("is node-scoped and severity=warning", () => {
      expect(rule.scope).toBe("node");
      expect(rule.severity).toBe("warning");
    });

    it("has a normativeQuote citing WCAG 1.3.1", () => {
      expect(rule.docs.normativeQuote).toContain("Information, structure, and relationships");
      expect(rule.docs.references[0]).toContain("info-and-relationships");
    });
  });
});
