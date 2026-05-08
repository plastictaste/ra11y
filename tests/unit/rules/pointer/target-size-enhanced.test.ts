import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/pointer/target-size-enhanced.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule pointer/target-size-enhanced", () => {
  describe("fires when (CSS)", () => {
    it("button selector pins width and height below 44px", () => {
      const v = runRule(rule, ".icon-btn { width: 32px; height: 32px; }", { filePath: "a.css" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("32×32");
      expect(v[0]?.message).toContain("44×44");
      expect(v[0]?.suggestion).toContain("44px");
    });

    it("min-width and min-height under threshold without padding", () => {
      const v = runRule(rule, "button.compact { min-width: 24px; min-height: 24px; }", {
        filePath: "a.css",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("24×24");
    });

    it("fires on a 30x30 button that satisfies AA but not AAA", () => {
      const v = runRule(rule, ".icon-btn { width: 30px; height: 30px; }", { filePath: "a.css" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("30×30");
    });

    it("input[type=checkbox] sized below threshold", () => {
      const v = runRule(rule, 'input[type="checkbox"] { width: 32px; height: 32px; }', {
        filePath: "a.css",
      });
      expect(v).toHaveLength(1);
    });
  });

  describe("fires when (JSX/Tailwind)", () => {
    it("flags a button with `w-8 h-8` (32x32 — passes AA, fails AAA)", () => {
      const v = runRule(rule, '<button className="w-8 h-8">x</button>', { filePath: "a.tsx" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("32×32");
      expect(v[0]?.suggestion).toContain("w-11 h-11");
    });

    it("flags a Tailwind arbitrary value `w-[40px] h-[40px]`", () => {
      const v = runRule(rule, '<button className="w-[40px] h-[40px]">x</button>', {
        filePath: "a.tsx",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("40×40");
    });

    it("flags a div with role=button sized too small for AAA", () => {
      const v = runRule(rule, '<div role="button" className="w-10 h-10" />', {
        filePath: "a.tsx",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("40×40");
    });
  });

  describe("does NOT fire when", () => {
    it("size meets the 44x44 threshold", () => {
      const v = runRule(rule, ".icon-btn { width: 44px; height: 44px; }", { filePath: "a.css" });
      expect(v).toHaveLength(0);
    });

    it("size exceeds the 44x44 threshold", () => {
      const v = runRule(rule, ".icon-btn { width: 48px; height: 48px; }", { filePath: "a.css" });
      expect(v).toHaveLength(0);
    });

    it("Tailwind `w-11 h-11` (44x44)", () => {
      const v = runRule(rule, '<button className="w-11 h-11">x</button>', { filePath: "a.tsx" });
      expect(v).toHaveLength(0);
    });

    it("Tailwind `w-12 h-12` (48x48) — comfortably above AAA", () => {
      const v = runRule(rule, '<button className="w-12 h-12">x</button>', { filePath: "a.tsx" });
      expect(v).toHaveLength(0);
    });

    it("padding compensates for an undersized box", () => {
      // 24×24 box + 10px padding on each side = 44×44 — meets AAA exactly.
      const v = runRule(rule, ".icon-btn { width: 24px; height: 24px; padding: 10px; }", {
        filePath: "a.css",
      });
      expect(v).toHaveLength(0);
    });

    it("interactive element is inside a <p> (Inline exception)", () => {
      const v = runRule(rule, '<p>read <a href="#" className="w-8 h-8">more</a> here</p>', {
        filePath: "a.tsx",
      });
      expect(v).toHaveLength(0);
    });

    it("input[type=range] is user-agent-determined", () => {
      const v = runRule(rule, '<input type="range" className="w-8 h-8" />', { filePath: "a.tsx" });
      expect(v).toHaveLength(0);
    });

    it("CSS selector is non-interactive (.card div)", () => {
      const v = runRule(rule, ".card { width: 32px; height: 32px; }", { filePath: "a.css" });
      expect(v).toHaveLength(0);
    });

    it("value uses calc() (unresolvable)", () => {
      const v = runRule(rule, "button { width: calc(2rem + 4px); height: calc(2rem + 4px); }", {
        filePath: "a.css",
      });
      expect(v).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("HTML inline style on an anchor", () => {
      const v = runRule(rule, '<a href="#" style="width: 32px; height: 32px;">x</a>', {
        filePath: "a.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("32×32");
    });

    it("does NOT fire for a 24x24 button covered by AA but failing AAA — that case is what THIS rule exists to flag", () => {
      // Confirms the rule is more strict than its AA sibling: 24x24 is fine for SC 2.5.8 but
      // below the SC 2.5.5 44x44 floor.
      const v = runRule(rule, ".icon-btn { width: 24px; height: 24px; }", { filePath: "a.css" });
      expect(v).toHaveLength(1);
    });
  });

  describe("metadata", () => {
    it("satisfies wcag22:2.5.5", () => {
      expect(rule.satisfies).toContain("wcag22:2.5.5");
    });

    it("satisfies wcag21:2.5.5", () => {
      expect(rule.satisfies).toContain("wcag21:2.5.5");
    });

    it("severity is warning (AAA is aspirational)", () => {
      expect(rule.severity).toBe("warning");
    });

    it("normativeQuote cites the 44x44 threshold", () => {
      expect(rule.docs.normativeQuote).toContain("44 by 44");
    });

    it("references list includes the WCAG 2.2 spec URL", () => {
      expect(rule.docs.references[0]).toContain("target-size-enhanced");
    });
  });
});
