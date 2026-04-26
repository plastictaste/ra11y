import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/semantics/inline-display-none-on-focusable.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule semantics/inline-display-none-on-focusable", () => {
  describe("fires a violation when", () => {
    it("a non-focusable wrapper hides a focusable descendant via inline display:none (the canonical dead-nav residue case)", () => {
      const violations = runRule(
        rule,
        `<ul><li style="display:none;"><a href="#topnav">HOME</a></li></ul>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("semantics/inline-display-none-on-focusable");
      expect(violations[0]?.message).toMatch(/focusable <a> descendant/);
      expect(violations[0]?.suggestion).toMatch(/`hidden` attribute/);
    });

    it("the focusable element itself carries inline display:none (self-focusable button)", () => {
      const violations = runRule(rule, `<button style="display: none">Close</button>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(
        /<button> has inline style="display:none" and is itself focusable/,
      );
    });

    it("a div with display:none contains a tabindex=0 descendant (custom focusable)", () => {
      const violations = runRule(
        rule,
        `<div style="display:none"><span tabindex="0" role="button">go</span></div>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/focusable <span> descendant/);
    });

    it("the declaration uses display: none !important", () => {
      const violations = runRule(
        rule,
        `<a href="/x" style="display: none !important;">stale link</a>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("the declaration uses uppercase DISPLAY: NONE", () => {
      const violations = runRule(rule, `<button style="DISPLAY: NONE">x</button>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("JSX: a non-focusable wrapper hides a focusable <a> via inline style", () => {
      const violations = runRule(
        rule,
        `export const X = () => <li style="display:none;"><a href="/x">HOME</a></li>;`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/focusable <a> descendant/);
    });
  });

  describe("does not fire when", () => {
    it("the inline style does not include display:none", () => {
      const violations = runRule(
        rule,
        `<div style="color: red"><a href="/x">visible link</a></div>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("display:none is on a non-focusable wrapper with no focusable descendants", () => {
      const violations = runRule(rule, `<div style="display:none">Plain text content</div>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("display:none wraps an anchor without an href (non-focusable)", () => {
      const violations = runRule(rule, `<li style="display:none"><a>placeholder</a></li>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("display:none wraps an input[type=hidden] (not focusable)", () => {
      const violations = runRule(
        rule,
        `<div style="display:none"><input type="hidden" name="csrf"></div>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the focusable descendant carries tabindex=-1 (programmatically focusable but not in tab order)", () => {
      const violations = runRule(
        rule,
        `<div style="display:none"><span tabindex="-1">x</span></div>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the property is `display-mode` or another lookalike, not `display`", () => {
      const violations = runRule(rule, `<button style="display-print: none">click</button>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("the value is `block` not `none`", () => {
      const violations = runRule(rule, `<button style="display: block">click</button>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("only flags one violation per offending element (does not double-report direct + descendant)", () => {
      const violations = runRule(
        rule,
        `<button style="display:none"><span tabindex="0">inner</span></button>`,
        { filePath: "input.html" },
      );
      // Direct (button is focusable) wins; we don't also emit for the descendant.
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(
        /<button> has inline style="display:none" and is itself focusable/,
      );
    });

    it("does not descend into PascalCase JSX components (treated as opaque)", () => {
      const violations = runRule(
        rule,
        `export const X = () => <div style="display:none"><CustomLink to="/x">go</CustomLink></div>;`,
        { filePath: "input.tsx" },
      );
      // We can't see whether <CustomLink/> renders a focusable; surface-don't-suppress
      // could argue either way, but the rule's contract is "static focusable child" —
      // a non-native PascalCase child is opaque.
      expect(violations).toHaveLength(0);
    });

    it("matches when inline style declares unrelated decls in addition to display:none", () => {
      const violations = runRule(
        rule,
        `<button style="color: red; display: none; padding: 4px">x</button>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
    });
  });
});
