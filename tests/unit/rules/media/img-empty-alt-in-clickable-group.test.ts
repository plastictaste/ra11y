import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/media/img-empty-alt-in-clickable-group.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule media/img-empty-alt-in-clickable-group", () => {
  describe("fires a violation when", () => {
    it("an icon-only <a href> wraps a single <img alt='' />", () => {
      const violations = runRule(rule, `<a href="/profile"><img src="avatar.png" alt=""></a>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("media/img-empty-alt-in-clickable-group");
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.suggestion).toMatch(/aria-label|descriptive alt/);
    });

    it("a <button> wraps only an <img alt=''>", () => {
      const violations = runRule(rule, `<button type="button"><img src="x.png" alt=""></button>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/<button>/);
    });

    it("a <div role='button' onclick> wraps only an <img alt=''>", () => {
      const violations = runRule(
        rule,
        `<div role="button" onclick="open()"><img src="star.png" alt=""></div>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/role="button"/);
    });

    it("a JSX <a href> wraps only an <img alt='' />", () => {
      const violations = runRule(
        rule,
        `export const X = () => <a href="/x"><img src="thumb.jpg" alt="" /></a>;`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("media/img-empty-alt-in-clickable-group");
    });

    it("a clickable group with whitespace-only alt is treated as empty", () => {
      const violations = runRule(rule, `<button><img src="x.png" alt="   "></button>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(1);
    });
  });

  describe("does not fire when", () => {
    it("the wrapping <button> has aria-label", () => {
      const violations = runRule(
        rule,
        `<button aria-label="Delete"><img src="trash.png" alt=""></button>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the wrapping <a> has sibling visible text", () => {
      const violations = runRule(rule, `<a href="/save"><img src="save.png" alt="">Save</a>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("the JSX wrapper has an expression child carrying the name", () => {
      const violations = runRule(
        rule,
        `export const X = ({label}) => <button><img src="x.png" alt="" />{label}</button>;`,
      );
      expect(violations).toHaveLength(0);
    });

    it("the <img> is not wrapped by an interactive element", () => {
      // This case is the responsibility of media/alt-text-missing /
      // generic alt review — not this rule.
      const violations = runRule(rule, `<div><img src="hero.png" alt=""></div>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("the wrapping <a> has aria-labelledby", () => {
      const violations = runRule(
        rule,
        `<span id="lbl">Profile</span><a href="/p" aria-labelledby="lbl"><img src="a.png" alt=""></a>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the wrapping <button> has a non-empty title attribute", () => {
      const violations = runRule(
        rule,
        `<button title="Close dialog"><img src="x.png" alt=""></button>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("a sibling <span aria-label> contributes a name", () => {
      const violations = runRule(
        rule,
        `<button><img src="x.png" alt=""><span aria-label="Close">×</span></button>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the <img> has a non-empty alt", () => {
      const violations = runRule(
        rule,
        `<a href="/p"><img src="avatar.png" alt="View profile"></a>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("does not climb through PascalCase JSX wrappers", () => {
      // PascalCase components are opaque — the rule stops the
      // ancestor walk at the wrapper boundary.
      const violations = runRule(
        rule,
        `export const X = () => <Card><a href="/p"><img src="a.png" alt="" /></a></Card>;`,
      );
      // The <a href> is still a native interactive ancestor — the
      // empty alt + unnamed <a> is a violation regardless of an
      // outer Card.
      expect(violations).toHaveLength(1);
    });

    it("expression-form alt is treated as runtime-derived (not flagged)", () => {
      const violations = runRule(
        rule,
        `export const X = ({alt}) => <button><img src="x.png" alt={alt} /></button>;`,
      );
      expect(violations).toHaveLength(0);
    });

    it("a missing alt attribute is not in scope (covered by alt-text-missing)", () => {
      const violations = runRule(rule, `<a href="/p"><img src="x.png"></a>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("a nested SVG with <title> contributes a name", () => {
      const violations = runRule(
        rule,
        `<button><img src="x.png" alt=""><svg><title>Close</title></svg></button>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });
});
