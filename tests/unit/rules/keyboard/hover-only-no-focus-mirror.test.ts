import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/keyboard/hover-only-no-focus-mirror.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule keyboard/hover-only-no-focus-mirror", () => {
  describe("fires a violation when", () => {
    it("a descendant overlay is revealed by transform on hover with no focus mirror", () => {
      const v = runRule(rule, `.movie:hover .overview { transform: translateY(0); }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.ruleId).toBe("keyboard/hover-only-no-focus-mirror");
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain("transform");
      expect(v[0]?.suggestion).toContain(":focus-within");
    });

    it("opacity is mutated on hover with no focus mirror", () => {
      const v = runRule(rule, `.tooltip-trigger:hover .tooltip { opacity: 1; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("opacity");
    });

    it("visibility flips on hover with no focus mirror", () => {
      const v = runRule(rule, `.menu:hover .submenu { visibility: visible; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("visibility");
    });

    it("display flips on hover with no focus mirror", () => {
      const v = runRule(rule, `.dropdown:hover .options { display: block; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(1);
    });

    it("the focus mirror exists but does not declare the same property", () => {
      const v = runRule(
        rule,
        `.card:hover .panel { transform: translateY(0); }
         .card:focus-within .panel { background-color: white; }`,
        { filePath: "styles.css" },
      );
      // Mirror selector exists but mutates a different property — does
      // not trigger the same reveal, so the predicate still fires.
      expect(v).toHaveLength(1);
    });
  });

  describe("does not fire when", () => {
    it("a :focus mirror declares the same property on the same selector chain", () => {
      const v = runRule(
        rule,
        `.btn:hover { transform: scale(1.1); }
         .btn:focus { transform: scale(1.1); }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(0);
    });

    it("a :focus-within mirror covers a descendant-reveal pattern", () => {
      const v = runRule(
        rule,
        `.movie:hover .overview { transform: translateY(0); }
         .movie:focus-within .overview { transform: translateY(0); }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(0);
    });

    it("the hover rule mutates only a color-family property (out of scope)", () => {
      const v = runRule(rule, `.btn:hover { color: red; background-color: blue; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
    });

    it("the hover and focus selectors are listed in a single comma-separated rule", () => {
      const v = runRule(
        rule,
        `.card:hover .panel,
         .card:focus-within .panel { transform: translateY(0); opacity: 1; }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(0);
    });

    it("the focus mirror declares a superset of the hover properties", () => {
      const v = runRule(
        rule,
        `.btn:hover { transform: scale(1.05); }
         .btn:focus { transform: scale(1.05); outline: 2px solid blue; }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("a non-CSS file is silently ignored", () => {
      const v = runRule(rule, `<div>nothing to see here</div>`, { filePath: "input.html" });
      expect(v).toHaveLength(0);
    });

    it("only the hover rule that lacks a mirror fires when several rules coexist", () => {
      const v = runRule(
        rule,
        `.a:hover { transform: scale(1.1); }
         .a:focus { transform: scale(1.1); }
         .b:hover { opacity: 1; }`,
        { filePath: "styles.css" },
      );
      // .a is mirrored, .b is not.
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain(".b:hover");
    });

    it("a sibling :focus rule with a different selector chain does not count as a mirror", () => {
      const v = runRule(
        rule,
        `.card:hover .panel { transform: translateY(0); }
         .different-card:focus-within .panel { transform: translateY(0); }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(1);
    });

    it("a `:hover-card` substring is not treated as the `:hover` pseudo", () => {
      // Defensive boundary test — `:hover` must match as a whole token,
      // not as a prefix of an identifier-like sequence. (CSS doesn't
      // normally have `:hover-foo` pseudos, but the regex must guard.)
      const v = runRule(rule, `.something[data-state=":hover-card"] { transform: scale(1); }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
    });
  });
});
