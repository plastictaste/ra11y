import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/semantics/heading-hierarchy.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule semantics/heading-hierarchy", () => {
  describe("missing h1", () => {
    it("fires when document has h2 but no h1", () => {
      const v = runRule(rule, `<h2>Section</h2>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("no <h1>");
    });

    it("fires when document starts with h3", () => {
      const v = runRule(rule, `<h3>Sub</h3>`, { filePath: "index.html" });
      // One "no h1" violation + one "skipped levels" violation (from
      // inferred h1 to h3 — but the skip check runs on the sequence,
      // not against the imaginary h1). Only "no h1" fires here.
      expect(v.some((x) => x.message.includes("no <h1>"))).toBe(true);
    });

    it("does not fire when h1 is present", () => {
      const v = runRule(rule, `<h1>Title</h1><h2>Section</h2>`, { filePath: "index.html" });
      expect(v).toHaveLength(0);
    });
  });

  describe("skipped levels", () => {
    it("fires when h1 is followed directly by h3", () => {
      const v = runRule(rule, `<h1>Title</h1><h3>Skipped</h3>`, { filePath: "index.html" });
      expect(v.some((x) => x.message.includes("skipped"))).toBe(true);
    });

    it("fires when h2 is followed by h4", () => {
      const v = runRule(rule, `<h1>Title</h1><h2>Section</h2><h4>Skipped</h4>`, {
        filePath: "index.html",
      });
      expect(v.some((x) => x.message.includes("skipped"))).toBe(true);
    });

    it("does not fire when levels increase by 1", () => {
      const v = runRule(rule, `<h1>Title</h1><h2>Section</h2><h3>Sub</h3>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("does not fire when levels decrease (jump back to top)", () => {
      const v = runRule(
        rule,
        `<h1>Title</h1><h2>A</h2><h3>A.1</h3><h2>B</h2><h1>New section</h1>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("suggestion proposes the corrective level", () => {
      const v = runRule(rule, `<h1>Title</h1><h4>Skipped</h4>`, { filePath: "index.html" });
      const skipV = v.find((x) => x.message.includes("skipped"));
      expect(skipV?.suggestion).toContain("<h2>");
    });

    it("cites the previous heading's line number in the message", () => {
      // Three blank lines between <h1> and <h5> so the previous-line
      // citation resolves to something other than the current line —
      // the whole point of the enrichment is that an agent can verify
      // the previous heading without re-walking the file.
      const source = `<h1>Title</h1>\n\n\n<h5>Way deeper</h5>`;
      const v = runRule(rule, source, { filePath: "index.html" });
      const skipV = v.find((x) => x.message.includes("skipped"));
      expect(skipV).toBeDefined();
      expect(skipV?.message).toContain("at line 1");
      expect(skipV?.message).toContain("<h1>");
      expect(skipV?.message).toContain("<h5>");
    });

    it("suggestion cites the previous heading's line number", () => {
      const source = `<h1>Title</h1>\n\n\n<h5>Way deeper</h5>`;
      const v = runRule(rule, source, { filePath: "index.html" });
      const skipV = v.find((x) => x.message.includes("skipped"));
      expect(skipV?.suggestion).toContain("line 1");
    });

    it("uses the most recent previous heading, not the first heading", () => {
      // h1 at line 1, h2 at line 3, then h5 at line 5 — the previous
      // heading cited should be <h2> at line 3, not <h1> at line 1.
      const source = `<h1>Title</h1>\n\n<h2>Section</h2>\n\n<h5>Skipped</h5>`;
      const v = runRule(rule, source, { filePath: "index.html" });
      const skipV = v.find((x) => x.message.includes("skipped"));
      expect(skipV?.message).toContain("<h2>");
      expect(skipV?.message).toContain("at line 3");
    });
  });

  it("does nothing on a document with no headings", () => {
    const v = runRule(rule, `<p>just paragraphs</p>`, { filePath: "index.html" });
    expect(v).toHaveLength(0);
  });

  it("cites wcag22:1.3.1 and wcag21:1.3.1", () => {
    expect(rule.satisfies).toContain("wcag22:1.3.1");
    expect(rule.satisfies).toContain("wcag21:1.3.1");
  });

  describe("partial / layout enrichment", () => {
    // Q4-HEADING-HIERARCHY-PARTIAL-ENRICH-REASON. Jekyll `_docs/*.md`,
    // `_includes/*.html`, Hugo partials, Eleventy includes — files
    // whose composed `<h1>` is supplied by the parent layout's
    // `page.title` front-matter. The rule still surfaces the candidate
    // (surface-don't-suppress); the enrichment annotates the message
    // and adds a structured `couldBeWrongBecause` so the agent reads
    // the composed layout in one pass.

    it("enriches missing-h1 message when path lives under _docs/", () => {
      const v = runRule(rule, `<h5>Subsection</h5>`, { filePath: "_docs/intro.html" });
      const missing = v.find((x) => x.message.includes("no <h1>"));
      expect(missing?.message).toContain("partial / layout");
      expect(missing?.couldBeWrongBecause).toContain(
        "partial_or_layout_file_requires_composed_check",
      );
    });

    it("enriches missing-h1 message when path lives under _includes/", () => {
      const v = runRule(rule, `<h3>Header text</h3>`, {
        filePath: "site/_includes/header.html",
      });
      const missing = v.find((x) => x.message.includes("no <h1>"));
      expect(missing?.couldBeWrongBecause).toContain(
        "partial_or_layout_file_requires_composed_check",
      );
    });

    it("enriches when first non-whitespace token is a Liquid {%- ... -%} directive", () => {
      // File path is a non-partial location, but the leading directive
      // signals partial composition just as strongly.
      const source = `{%- include head.html -%}\n<h4>Section</h4>`;
      const v = runRule(rule, source, { filePath: "page.html" });
      const missing = v.find((x) => x.message.includes("no <h1>"));
      expect(missing?.couldBeWrongBecause).toContain(
        "partial_or_layout_file_requires_composed_check",
      );
    });

    it("enriches when first non-whitespace token is a {{ ... }} interpolation", () => {
      const source = `{{ page.title }}\n<h2>Sub</h2>`;
      const v = runRule(rule, source, { filePath: "page.html" });
      const missing = v.find((x) => x.message.includes("no <h1>"));
      expect(missing?.couldBeWrongBecause).toContain(
        "partial_or_layout_file_requires_composed_check",
      );
    });

    it("enriches the skipped-level emit too, not just missing-h1", () => {
      // h1 present so missing-h1 does NOT fire — but h1 → h3 skip does.
      const v = runRule(rule, `<h1>Title</h1><h3>Skipped</h3>`, {
        filePath: "_layouts/default.html",
      });
      const skipped = v.find((x) => x.message.includes("skipped"));
      expect(skipped?.couldBeWrongBecause).toContain(
        "partial_or_layout_file_requires_composed_check",
      );
      expect(skipped?.message).toContain("partial / layout");
    });

    it("does NOT enrich on a regular full-page file", () => {
      // Same heading shape as the partial cases above, but the file
      // path is a normal page and the source has no leading directive.
      const v = runRule(rule, `<h5>Subsection</h5>`, { filePath: "src/pages/about.html" });
      const missing = v.find((x) => x.message.includes("no <h1>"));
      expect(missing).toBeDefined();
      expect(missing?.couldBeWrongBecause).toBeUndefined();
      expect(missing?.message).not.toContain("partial / layout");
    });

    it("path matcher is segment-flanked — `my_layouts/` does NOT match `_layouts/`", () => {
      // `my_layouts` is not a partial directory; the match must require
      // the underscore-prefixed segment to be flanked by `/` (or
      // boundary), not appear as a substring inside a longer name.
      const v = runRule(rule, `<h5>Subsection</h5>`, {
        filePath: "src/my_layouts_extras/page.html",
      });
      const missing = v.find((x) => x.message.includes("no <h1>"));
      expect(missing?.couldBeWrongBecause).toBeUndefined();
    });

    it("does NOT enrich when an HTML comment leads the file", () => {
      // An HTML comment at the top is a full-page signal (license
      // header, build-tool stamp), not a partial signal.
      const source = `<!-- generated by build -->\n<h5>Subsection</h5>`;
      const v = runRule(rule, source, { filePath: "page.html" });
      const missing = v.find((x) => x.message.includes("no <h1>"));
      expect(missing?.couldBeWrongBecause).toBeUndefined();
    });
  });
});
