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

  describe("aria-labelledby alternative when a heading precedes the table", () => {
    it("HTML: heading has an id — suggestion wires aria-labelledby to it and evidence carries id", () => {
      const violations = runRule(
        rule,
        `<section>
          <h2 id="sales-q1">Quarterly sales by region</h2>
          <table>
            <tr><th scope="col">Region</th></tr>
            <tr><td>North</td></tr>
          </table>
        </section>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      const v = violations[0];
      expect(v?.suggestion).toContain('aria-labelledby="sales-q1"');
      expect(v?.suggestion).toContain("<h2>");
      // Both fix paths surfaced in one suggestion — the <caption>
      // template and the aria-labelledby alternative.
      expect(v?.suggestion).toContain("<caption>Quarterly sales by region</caption>");
      const evidence = v?.evidence;
      expect(evidence?.kind).toBe("table-caption-preceding-heading");
      if (evidence?.kind === "table-caption-preceding-heading") {
        expect(evidence.tag).toBe("h2");
        expect(evidence.id).toBe("sales-q1");
        expect(typeof evidence.line).toBe("number");
      }
    });

    it("HTML: heading has no id — suggestion instructs adding an id then wiring aria-labelledby; evidence omits id", () => {
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
      const v = violations[0];
      // Auto-id guidance: instruct adding a slug to the heading, then
      // referencing it from aria-labelledby.
      expect(v?.suggestion).toContain('id="<slug>"');
      expect(v?.suggestion).toContain('aria-labelledby="<slug>"');
      const evidence = v?.evidence;
      expect(evidence?.kind).toBe("table-caption-preceding-heading");
      if (evidence?.kind === "table-caption-preceding-heading") {
        expect(evidence.tag).toBe("h2");
        // Present-when-meaningful: id is omitted when the heading
        // doesn't already carry one.
        expect(evidence.id).toBeUndefined();
        expect(typeof evidence.line).toBe("number");
      }
    });

    it("HTML: no preceding heading — default reason and <caption> fix; no preceding-heading evidence", () => {
      const violations = runRule(
        rule,
        `<table>
          <tr><th scope="col">Region</th></tr>
          <tr><td>North</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      const v = violations[0];
      // Default reason path: generic aria-labelledby fallback prose, no
      // concrete heading anchor, structured evidence omitted entirely.
      expect(v?.suggestion).toContain("<caption>Describe what this table shows</caption>");
      expect(v?.suggestion).toContain('aria-labelledby="<id-of-existing-heading>"');
      expect(v?.evidence).toBeUndefined();
    });

    it("JSX: heading has an id — suggestion wires aria-labelledby and evidence carries id", () => {
      const violations = runRule(
        rule,
        `const x = (
          <section>
            <h2 id="inv-hdr">Product inventory</h2>
            <table>
              <tr><th>SKU</th></tr>
              <tr><td>A-001</td></tr>
            </table>
          </section>
        );`,
        { filePath: "file.tsx" },
      );
      expect(violations).toHaveLength(1);
      const v = violations[0];
      expect(v?.suggestion).toContain('aria-labelledby="inv-hdr"');
      const evidence = v?.evidence;
      expect(evidence?.kind).toBe("table-caption-preceding-heading");
      if (evidence?.kind === "table-caption-preceding-heading") {
        expect(evidence.tag).toBe("h2");
        expect(evidence.id).toBe("inv-hdr");
      }
    });

    it("JSX: heading has no id — suggestion instructs adding an id then wiring aria-labelledby", () => {
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
      const v = violations[0];
      expect(v?.suggestion).toContain('id="<slug>"');
      expect(v?.suggestion).toContain('aria-labelledby="<slug>"');
      const evidence = v?.evidence;
      expect(evidence?.kind).toBe("table-caption-preceding-heading");
      if (evidence?.kind === "table-caption-preceding-heading") {
        expect(evidence.id).toBeUndefined();
      }
    });
  });

  describe("conceded-uncertainty: markdown-source / fragment host file", () => {
    // Per `docs/kb/architecture/ai-first-consumer.md` "Per-finding
    // confidence must reflect per-rule coverage limitations" + "Parser-
    // failure invalidates per-file confidence": when the host file is
    // a Markdown source (`.md`/`.markdown`/`.mkdn`) OR fragment-
    // classified (no `<html>`/`<body>`, no layout directive, not under
    // `_layouts/`), the rule's "no accessible name" claim concedes its
    // predicate may not hold. Surface the finding (per "Surface,
    // don't suppress") with `confidence: "medium"` and a
    // `couldBeWrongBecause` code naming the conceded axis.
    it("downgrades confidence to medium and attaches markdown reason on a .md host file", () => {
      const violations = runRule(
        rule,
        `<table>
          <thead><tr><th>Region</th><th>Q1</th></tr></thead>
          <tbody><tr><td>North</td><td>$100</td></tr></tbody>
        </table>`,
        { filePath: "docs/sales.md" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.confidence).toBe("medium");
      // The `.md` extension fires the markdown axis. The file also
      // happens to be fragment-classified (no <html>/<body> envelope,
      // no layout directive, not under _layouts/), so the fragment
      // axis fires too — both codes ride the same finding because the
      // predicate-uncertainty has two distinct sources.
      expect(violations[0]?.couldBeWrongBecause).toEqual([
        "markdown_table_no_caption_syntax_in_md",
        "fragment_input_no_document_envelope",
      ]);
    });

    it("downgrades on .markdown and .mkdn extensions equivalently", () => {
      const tableSnippet = `<table><tr><th>A</th></tr><tr><td>1</td></tr></table>`;
      const a = runRule(rule, tableSnippet, { filePath: "x.markdown" });
      const b = runRule(rule, tableSnippet, { filePath: "x.mkdn" });
      expect(a[0]?.confidence).toBe("medium");
      expect(b[0]?.confidence).toBe("medium");
      expect(a[0]?.couldBeWrongBecause).toContain("markdown_table_no_caption_syntax_in_md");
      expect(b[0]?.couldBeWrongBecause).toContain("markdown_table_no_caption_syntax_in_md");
    });

    it("annotates the message with the markdown conceded-uncertainty suffix", () => {
      const violations = runRule(rule, `<table><tr><th>A</th></tr><tr><td>1</td></tr></table>`, {
        filePath: "docs/page.md",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("Markdown source");
      expect(violations[0]?.message).toContain("no first-class caption syntax");
    });

    it("severity stays unchanged on the conceded-uncertainty branch (warning, not error)", () => {
      // Severity is the budget axis; confidence is the predicate-
      // strength axis. The conceded-uncertainty downgrade lives on
      // the confidence axis only.
      const violations = runRule(rule, `<table><tr><th>A</th></tr><tr><td>1</td></tr></table>`, {
        filePath: "page.md",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.confidence).toBe("medium");
    });

    it("downgrades on a fragment-classified .html file with the fragment axis only", () => {
      // Plain fragment HTML (no <html>/<body>, no layout directive,
      // path NOT under _layouts/) — fragment axis fires; markdown
      // axis does not (extension is .html). Single code.
      const violations = runRule(
        rule,
        `<div><table><tr><th>A</th></tr><tr><td>1</td></tr></table></div>`,
        { filePath: "_includes/data.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.confidence).toBe("medium");
      expect(violations[0]?.couldBeWrongBecause).toEqual(["fragment_input_no_document_envelope"]);
    });

    it("does NOT downgrade on a full-page .html file with <html>/<body>", () => {
      // Full document envelope — both axes negative. Rule emits at
      // its normal high-confidence shape (no per-finding confidence
      // field, no couldBeWrongBecause field).
      const violations = runRule(
        rule,
        `<!DOCTYPE html><html><body><table><tr><th>A</th></tr><tr><td>1</td></tr></table></body></html>`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.confidence).toBeUndefined();
      expect(violations[0]?.couldBeWrongBecause).toBeUndefined();
    });

    it("does NOT downgrade on a layout file under _layouts/ (positive page-envelope evidence)", () => {
      // Files under _layouts/ render AS the page envelope via parent-
      // layout composition — they are NOT fragments. Markdown axis
      // negative, fragment axis vetoed by inLayoutsDir signal.
      const violations = runRule(
        rule,
        `<!DOCTYPE html><html><body>{{ content }}<table><tr><th>A</th></tr><tr><td>1</td></tr></table></body></html>`,
        { filePath: "_layouts/page.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.confidence).toBeUndefined();
      expect(violations[0]?.couldBeWrongBecause).toBeUndefined();
    });

    it("JSX files do not engage the markdown / fragment gate (file-scoped by design)", () => {
      // JSX modules are file-scoped by design (no document-envelope
      // concept and no markdown-residue projection). The conceded-
      // uncertainty gate stays off on the JSX branch even if the
      // emit shape would otherwise carry the codes.
      const violations = runRule(
        rule,
        `function Page() { return (<table><tr><th>A</th></tr><tr><td>1</td></tr></table>); }`,
        { filePath: "Page.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.confidence).toBeUndefined();
      expect(violations[0]?.couldBeWrongBecause).toBeUndefined();
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
