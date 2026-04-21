import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/media/alt-text-placeholder.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule media/alt-text-placeholder", () => {
  describe("HTML: fires a violation when", () => {
    it("alt is the medium word 'image'", () => {
      const violations = runRule(rule, `<img src="x.png" alt="image">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("media/alt-text-placeholder");
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.criteria).toContain("wcag22:1.1.1");
      expect(violations[0]?.suggestion).toMatch(/alt=""/);
    });

    it("alt is a case-mixed medium word ('Screenshot')", () => {
      const violations = runRule(rule, `<img src="x.png" alt="Screenshot">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/restates the medium/);
    });

    it("alt is an authoring placeholder ('TODO')", () => {
      const violations = runRule(rule, `<img src="x.png" alt="TODO">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/authoring placeholder/);
    });

    it("alt is 'placeholder'", () => {
      const violations = runRule(rule, `<img src="x.png" alt="placeholder">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("alt is a meta word ('description')", () => {
      const violations = runRule(rule, `<img src="x.png" alt="description">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/names the attribute/);
    });

    it("alt is single-word repetition ('image image')", () => {
      const violations = runRule(rule, `<img src="x.png" alt="image image">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/repeats a single word/);
    });

    it("alt is 'fix me' (multi-word authoring placeholder)", () => {
      const violations = runRule(rule, `<img src="x.png" alt="fix me">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("<input type='image'> has placeholder alt", () => {
      const violations = runRule(rule, `<input type="image" src="go.png" alt="image">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });
  });

  describe("HTML: does not fire when", () => {
    it("alt is a real description that happens to contain 'image'", () => {
      const violations = runRule(rule, `<img src="p.png" alt="Aerial image of Paris at dusk">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("alt is a real description that starts with 'Screenshot of'", () => {
      const violations = runRule(
        rule,
        `<img src="ss.png" alt="Screenshot of the dashboard with Q4 sales chart">`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("alt is explicitly empty (decorative)", () => {
      const violations = runRule(rule, `<img src="f.png" alt="">`, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });

    it("alt attribute is absent (missing rule owns this)", () => {
      const violations = runRule(rule, `<img src="f.png">`, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });

    it("alt is whitespace-only (missing rule owns this)", () => {
      const violations = runRule(rule, `<img src="f.png" alt="   ">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("alt is a meaningful non-placeholder sentence", () => {
      const violations = runRule(
        rule,
        `<img src="c.png" alt="Bar chart: Q1 $1.2M, Q2 $2.4M, Q3 $3.1M, Q4 $3.8M">`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires a violation when", () => {
    it("alt prop is 'image'", () => {
      const violations = runRule(rule, `const X = <img src="x.png" alt="image" />;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("media/alt-text-placeholder");
    });

    it("alt prop is 'TODO'", () => {
      const violations = runRule(rule, `const X = <img src="x.png" alt="TODO" />;`);
      expect(violations).toHaveLength(1);
    });

    it("alt prop is 'FIXME' (case insensitive)", () => {
      const violations = runRule(rule, `const X = <img src="x.png" alt="FIXME" />;`);
      expect(violations).toHaveLength(1);
    });

    it("multiple offending imgs produce multiple violations", () => {
      const src = `const X = <div><img src="a.png" alt="image" /><img src="b.png" alt="TODO" /></div>;`;
      const violations = runRule(rule, src);
      expect(violations).toHaveLength(2);
    });

    it("wrapper-mapped component (Avatar → img) with placeholder alt", () => {
      const violations = runRule(rule, `const X = <Avatar src="me.png" alt="photo" />;`, {
        nativeWrapperElements: { Avatar: "img" },
      });
      expect(violations).toHaveLength(1);
    });
  });

  describe("JSX: does not fire when", () => {
    it("alt prop is a real description", () => {
      const violations = runRule(
        rule,
        `const X = <img src="c.png" alt="Revenue chart showing 220% YoY growth" />;`,
      );
      expect(violations).toHaveLength(0);
    });

    it("alt prop is an expression (runtime value, not statically a placeholder)", () => {
      const violations = runRule(rule, `const X = <img src="x.png" alt={caption} />;`);
      expect(violations).toHaveLength(0);
    });

    it("alt is empty (decorative)", () => {
      const violations = runRule(rule, `const X = <img src="f.png" alt="" />;`);
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("alt with leading/trailing whitespace ('  image  ') still matches", () => {
      const violations = runRule(rule, `<img src="x.png" alt="  image  ">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("repetition requires the exact same token (not 'image picture')", () => {
      const violations = runRule(rule, `<img src="x.png" alt="image picture">`, {
        filePath: "index.html",
      });
      // Two different medium words: fails to match any single-word
      // category AND fails the repetition check. We intentionally do
      // not flag composed medium phrases — keeping the rule honest
      // avoids encoding a heuristic about what "basically a medium
      // restatement" looks like.
      expect(violations).toHaveLength(0);
    });

    it("alt='icon' flags (standalone icon word)", () => {
      const violations = runRule(rule, `<img src="x.png" alt="icon">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("alt='home icon' does not flag (descriptive use of 'icon')", () => {
      const violations = runRule(rule, `<img src="x.png" alt="home icon">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });
  });
});
