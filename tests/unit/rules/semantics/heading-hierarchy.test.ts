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
});
