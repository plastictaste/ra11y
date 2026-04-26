import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/aria/icon-child-missing-aria-hidden.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule aria/icon-child-missing-aria-hidden", () => {
  describe("fires a violation when", () => {
    it("an unnamed <button> wraps an unhidden Font Awesome glyph (HTML)", () => {
      const violations = runRule(rule, `<button><i class="fa fa-trash"></i></button>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("aria/icon-child-missing-aria-hidden");
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.suggestion).toMatch(/aria-hidden="true"/);
      expect(violations[0]?.message).toMatch(/unnamed <button>/);
    });

    it("an unnamed <a href> wraps an unhidden Font Awesome glyph (HTML)", () => {
      const violations = runRule(rule, `<a href="/cart"><i class="fa fa-shopping-cart"></i></a>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/Font Awesome/);
      expect(violations[0]?.message).toMatch(/unnamed <a>/);
    });

    it("an unnamed JSX <button> wraps an unhidden Material Icons glyph", () => {
      const violations = runRule(
        rule,
        `export const X = () => <button><span className="material-icons">delete</span></button>;`,
      );
      // Visible text "delete" is the icon glyph identifier — but for
      // material-icons that text IS the icon and the parent has no other
      // accessible-name source. The shared `accessibleNameJsx` excludes
      // text contributed by icon-font children, so the parent reads as
      // unnamed.
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/Material Icons/);
    });

    it("an unnamed <button> wraps an unhidden Bootstrap Icons glyph (JSX)", () => {
      const violations = runRule(
        rule,
        `export const X = () => <button><i className="bi bi-trash" /></button>;`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/Bootstrap Icons/);
    });

    it("an unnamed <button> wraps an unhidden <ion-icon> custom element", () => {
      const violations = runRule(rule, `<button><ion-icon name="close"></ion-icon></button>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/Ionicons/);
    });
  });

  describe("does not fire when", () => {
    it('the icon already carries aria-hidden="true"', () => {
      const violations = runRule(
        rule,
        `<button><i class="fa fa-trash" aria-hidden="true"></i></button>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the parent <button> has visible text alongside the icon", () => {
      // Parent IS named ("Delete") — the labeled-icon double-announce
      // case is `aria/icon-font-hidden`'s job, not ours.
      const violations = runRule(rule, `<button><i class="fa fa-trash"></i> Delete</button>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("the parent <button> has aria-label", () => {
      const violations = runRule(
        rule,
        `<button aria-label="Delete"><i class="fa fa-trash"></i></button>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the parent <a> has only a title attribute (deferred to title-relies pass)", () => {
      // The `aria/icon-font-hidden` variantKey "relies-on-title" pass
      // owns this row — firing here would duplicate that finding's
      // framing. The defer keeps each anti-pattern surface uncluttered.
      const violations = runRule(
        rule,
        `<a href="/" title="Facebook"><i class="fa fa-facebook"></i></a>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it('the icon carries role="presentation"', () => {
      const violations = runRule(
        rule,
        `<button><i class="fa fa-trash" role="presentation"></i></button>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the parent is a non-interactive <div> wrapping an icon", () => {
      // Decorative icon-fonts in non-interactive prose are handled by
      // `aria/icon-font-hidden` variantKey "prose-context", not us.
      const violations = runRule(rule, `<div><i class="fa fa-info"></i></div>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("the parent JSX is a PascalCase component (opaque, skipped)", () => {
      const violations = runRule(
        rule,
        `export const X = () => <Button><i className="fa fa-trash" /></Button>;`,
      );
      expect(violations).toHaveLength(0);
    });

    it("the parent <a> has no href (not interactive without it)", () => {
      const violations = runRule(rule, `<a><i class="fa fa-trash"></i></a>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("a nested icon inside a nested unnamed interactive emits once", () => {
      // Outer <button> visits the inner <a>; descent stops at the
      // interactive boundary. Inner <a> has its own iteration. We
      // expect exactly one finding (on the inner-most icon), not two.
      const violations = runRule(
        rule,
        `<button><a href="/x"><i class="fa fa-cog"></i></a></button>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it('a role="button" element with no name gets the same treatment', () => {
      const violations = runRule(
        rule,
        `<div role="button" tabindex="0"><i class="fa fa-cog"></i></div>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/unnamed <div>/);
    });
  });
});
